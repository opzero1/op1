import { copyFile, stat, symlink } from "node:fs/promises";
import { basename } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { summarizeAgentStatus } from "./agent-status.js";
import { join, mkdir } from "./bun-compat.js";
import { generateTaskID } from "./ids.js";
import { createLogger } from "./logging.js";
import {
	extractLatestAssistantText,
	extractPromptResponseText,
	formatFullSession,
} from "./messages.js";
import {
	type DelegationCategory,
	type DelegationRoutingTelemetry,
	parseDelegationCategory,
	resolveDelegationRouting,
} from "./router.js";
import {
	createTaskStateManager,
	isManagerOwnedCAIDTask,
	type TaskAssignmentRecord,
	type TaskExecutionRecord,
	type TaskRecord,
	type TaskStateManager,
	type TaskStatus,
} from "./state.js";
import { buildTaskGraph } from "./task-graph.js";
import {
	buildTaskCollectionMetadata,
	buildTaskPayload,
	buildTaskToolMetadata,
	type CanonicalTaskPayload,
} from "./task-payload.js";
import { createToolMetadataStore } from "./tool-metadata.js";
import type {
	BackgroundCancelArgs,
	BackgroundOutputArgs,
	DelegationClient,
	DelegationToolContext,
	DelegationToolExecuteAfterInput,
	DelegationToolResult,
	TaskToolArgs,
} from "./types.js";
import { sleep } from "./utils.js";

const MAX_RUNNING_PER_AGENT = 5;
const DEFAULT_BLOCK_TIMEOUT_MS = 60_000;

interface RuntimeEvent {
	type?: string;
	properties?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function readStringField(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}

	return undefined;
}

function getSessionParentID(data: Record<string, unknown>): string | undefined {
	return readStringField(data, ["parentID", "parentId", "parent_id"]);
}

function readSessionStatusValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}

	const record = asRecord(value);
	if (!record) return undefined;

	const direct = readStringField(record, ["type", "status"]);
	if (direct) return direct;

	const nestedState = asRecord(record.state);
	if (!nestedState) return undefined;

	return readStringField(nestedState, ["type", "status"]);
}

function getEventSessionID(event: RuntimeEvent): string | null {
	const properties = event.properties;
	if (!properties) return null;

	const directSessionID = readStringField(properties, [
		"sessionID",
		"sessionId",
		"session_id",
		"id",
	]);
	if (directSessionID) return directSessionID;

	const info = properties.info;
	const infoRecord = asRecord(info);
	if (!infoRecord) return null;

	return (
		readStringField(infoRecord, [
			"sessionID",
			"sessionId",
			"session_id",
			"id",
		]) ?? null
	);
}

function getEventError(event: RuntimeEvent): string {
	const properties = event.properties;
	if (!properties) return "Session error event received";

	if (typeof properties.error === "string") {
		return properties.error;
	}

	if (typeof properties.message === "string") {
		return properties.message;
	}

	const errorValue = properties.error;
	if (errorValue && typeof errorValue === "object") {
		const errorRecord = errorValue as Record<string, unknown>;
		if (typeof errorRecord.message === "string") {
			return errorRecord.message;
		}
	}

	return "Session error event received";
}

function getSessionIDFromCreateResponse(data: unknown): string | null {
	const record = asRecord(data);
	if (!record) return null;

	const direct = readStringField(record, [
		"id",
		"sessionID",
		"sessionId",
		"session_id",
	]);
	if (direct) return direct;

	const nestedSession = asRecord(record.session);
	if (!nestedSession) return null;

	return (
		readStringField(nestedSession, [
			"id",
			"sessionID",
			"sessionId",
			"session_id",
		]) ?? null
	);
}

async function createChildSessionForTask(
	client: DelegationClient,
	input: {
		description: string;
		agent: string;
		parent_session_id: string;
		directory?: string;
	},
	logger: ReturnType<typeof createLogger>,
): Promise<string> {
	logger.info("Creating child session", {
		agent: input.agent,
		parent_session_id: input.parent_session_id,
		description: input.description,
	});
	const session = await client.session.create({
		body: {
			title: `${input.description} (@${input.agent} task)`,
			parentID: input.parent_session_id,
		},
		query: input.directory ? { directory: input.directory } : undefined,
	});
	if (session.error) {
		logger.warn("Child session creation failed", {
			agent: input.agent,
			parent_session_id: input.parent_session_id,
			error: String(session.error),
		});
		throw new Error(String(session.error));
	}

	const childSessionID = getSessionIDFromCreateResponse(session.data);
	if (!childSessionID) {
		logger.warn("Child session creation returned no session id", {
			agent: input.agent,
			parent_session_id: input.parent_session_id,
		});
		throw new Error("Failed to create child session for task.");
	}

	logger.info("Child session created", {
		agent: input.agent,
		parent_session_id: input.parent_session_id,
		child_session_id: childSessionID,
	});

	return childSessionID;
}

function isActiveTask(status: TaskStatus): boolean {
	return status === "queued" || status === "blocked" || status === "running";
}

function isWorktreeEligibleAgent(agent: string): boolean {
	return agent === "build" || agent === "coder" || agent === "frontend";
}

function sanitizeBranchName(input: string): string | null {
	let name = input
		.trim()
		.replace(/[^\w\-./]/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/\/{2,}/g, "/")
		.replace(/^[.\-/]+/, "")
		.replace(/[.\-/]+$/, "")
		.replace(/\.lock$/i, "");

	if (!name) return null;
	if (name.length > 200) {
		name = name.slice(0, 200);
	}

	return name;
}

async function runGitCommand(
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { code, stdout, stderr };
}

async function runShellCommand(
	command: string,
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["sh", "-lc", command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { code, stdout, stderr };
}

async function pathExists(pathValue: string): Promise<boolean> {
	try {
		await stat(pathValue);
		return true;
	} catch {
		return false;
	}
}

async function copyIfExists(
	source: string,
	destination: string,
): Promise<void> {
	if (!(await pathExists(source))) return;
	await copyFile(source, destination).catch(() => undefined);
}

async function symlinkIfExists(
	source: string,
	destination: string,
): Promise<void> {
	if (!(await pathExists(source))) return;
	await symlink(source, destination).catch(() => undefined);
}

async function prepareTaskExecution(
	directory: string,
	input: {
		taskID: string;
		agent: string;
		existing?: TaskExecutionRecord;
	},
	logger: ReturnType<typeof createLogger>,
): Promise<TaskExecutionRecord> {
	if (!isWorktreeEligibleAgent(input.agent)) {
		return { mode: "direct", merge_status: "bypassed" };
	}

	if (
		input.existing?.mode === "worktree" &&
		input.existing.worktree_path &&
		(await pathExists(input.existing.worktree_path))
	) {
		return input.existing;
	}

	const repoCheck = await runGitCommand(
		["rev-parse", "--show-toplevel"],
		directory,
	);
	if (repoCheck.code !== 0) {
		logger.info("Skipping worktree execution outside git repo", {
			task_id: input.taskID,
			agent: input.agent,
		});
		return { mode: "direct", merge_status: "bypassed" };
	}

	const repoRoot = repoCheck.stdout.trim() || directory;
	const branchResult = await runGitCommand(
		["rev-parse", "--abbrev-ref", "HEAD"],
		repoRoot,
	);
	const baseBranch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
	if (!baseBranch || baseBranch === "HEAD") {
		logger.warn("Skipping worktree execution without base branch", {
			task_id: input.taskID,
			agent: input.agent,
			base_branch: baseBranch || undefined,
		});
		return { mode: "direct", merge_status: "bypassed" };
	}

	const branch = sanitizeBranchName(`op1/${input.agent}/${input.taskID}`);
	if (!branch) {
		return { mode: "direct", merge_status: "bypassed" };
	}

	const worktreeBase = join(repoRoot, "..", `${basename(repoRoot)}-worktrees`);
	await mkdir(worktreeBase, { recursive: true });
	const worktreePath = join(worktreeBase, branch.replace(/\//g, "-"));

	if (!(await pathExists(worktreePath))) {
		const createResult = await runGitCommand(
			["worktree", "add", "-b", branch, worktreePath, baseBranch],
			repoRoot,
		);
		if (createResult.code !== 0) {
			logger.warn(
				"Worktree creation failed; falling back to direct execution",
				{
					task_id: input.taskID,
					agent: input.agent,
					branch,
					error: createResult.stderr.trim() || createResult.stdout.trim(),
				},
			);
			return { mode: "direct", merge_status: "bypassed" };
		}

		await Promise.all([
			copyIfExists(join(repoRoot, ".env"), join(worktreePath, ".env")),
			copyIfExists(
				join(repoRoot, ".env.local"),
				join(worktreePath, ".env.local"),
			),
			symlinkIfExists(
				join(repoRoot, "node_modules"),
				join(worktreePath, "node_modules"),
			),
			symlinkIfExists(join(repoRoot, ".bun"), join(worktreePath, ".bun")),
		]);
	}

	return {
		mode: "worktree",
		branch,
		base_branch: baseBranch,
		worktree_path: worktreePath,
		merge_status: "pending",
		verification_status: "pending",
		verification_command: await detectDefaultVerificationCommand(repoRoot),
		retry_count: input.existing?.retry_count,
	};
}

async function detectDefaultVerificationCommand(
	directory: string,
): Promise<string | undefined> {
	const checks = await Promise.all([
		Bun.file(join(directory, "bun.lock")).exists(),
		Bun.file(join(directory, "bun.lockb")).exists(),
		Bun.file(join(directory, "package.json")).exists(),
		Bun.file(join(directory, "pnpm-lock.yaml")).exists(),
		Bun.file(join(directory, "yarn.lock")).exists(),
		Bun.file(join(directory, "package-lock.json")).exists(),
		Bun.file(join(directory, "go.mod")).exists(),
		Bun.file(join(directory, "Cargo.toml")).exists(),
	]);

	if (checks[0] || checks[1]) return "bun test";
	if (checks[3]) return "pnpm test";
	if (checks[4]) return "yarn test";
	if (checks[5]) return "npm test";
	if (checks[6]) return "go test ./...";
	if (checks[7]) return "cargo test";
	if (checks[2]) return "npm test";
	return undefined;
}

async function hasUncommittedChanges(directory: string): Promise<boolean> {
	const status = await runGitCommand(["status", "--porcelain"], directory);
	return status.code === 0 && status.stdout.trim().length > 0;
}

interface VerificationSelection {
	command?: string;
	strategy: "targeted" | "fallback";
	candidateCommands: string[];
	fallbackCommand?: string;
	reason: string;
}

type ManagerAssignment = NonNullable<TaskRecord["assignment"]>;
type ManagerRetry = NonNullable<ManagerAssignment["retry"]>;
type ManagerReview = NonNullable<ManagerAssignment["review"]>;

function quoteShellArgument(value: string): string {
	return JSON.stringify(value);
}

function buildManagerAssignment(
	task: TaskRecord,
	patch: Partial<TaskAssignmentRecord>,
): TaskAssignmentRecord | undefined {
	if (!isManagerOwnedCAIDTask(task)) return task.assignment;

	return {
		...(task.assignment ?? { owner: "manager", workflow: "caid" }),
		...patch,
	};
}

function managerReviewStatus(task: TaskRecord): ManagerReview["status"] {
	return task.assignment?.review?.status;
}

function managerRetryState(task: TaskRecord): ManagerRetry["state"] {
	return task.assignment?.retry?.state;
}

function managerRetryReason(task: TaskRecord): ManagerRetry["reason"] {
	return task.assignment?.retry?.reason;
}

function isManagerReviewPending(task: TaskRecord): boolean {
	return managerReviewStatus(task) === "pending";
}

function isManagerReviewPass(task: TaskRecord): boolean {
	return (
		isManagerOwnedCAIDTask(task) && managerReviewStatus(task) === "running"
	);
}

function clearManagerRetry(task: TaskRecord): TaskAssignmentRecord | undefined {
	if (!isManagerOwnedCAIDTask(task)) return task.assignment;

	return buildManagerAssignment(task, {
		retry: {
			reason: undefined,
			state: "idle",
			last_resync_status: task.assignment?.retry?.last_resync_status,
			last_resync_at: task.assignment?.retry?.last_resync_at,
			last_resync_summary: task.assignment?.retry?.last_resync_summary,
		},
	});
}

async function listChangedFilesAgainstBase(
	execution: TaskExecutionRecord,
): Promise<string[]> {
	if (
		execution.mode !== "worktree" ||
		!execution.worktree_path ||
		!execution.base_branch
	) {
		return [];
	}

	const [committedDiff, workingDiff, stagedDiff] = await Promise.all([
		runGitCommand(
			["diff", "--name-only", `${execution.base_branch}...HEAD`],
			execution.worktree_path,
		),
		runGitCommand(["diff", "--name-only"], execution.worktree_path),
		runGitCommand(["diff", "--cached", "--name-only"], execution.worktree_path),
	]);

	return [
		...new Set(
			[committedDiff.stdout, workingDiff.stdout, stagedDiff.stdout]
				.join("\n")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		),
	];
}

function isBunTestFile(pathValue: string): boolean {
	return /(^|\/)(__tests__\/.*|.*\.(test|spec))\.[cm]?[jt]sx?$/.test(pathValue);
}

function selectTargetedVerificationCommand(
	changedFiles: string[],
): Omit<VerificationSelection, "fallbackCommand" | "strategy"> | null {
	if (changedFiles.length === 0) {
		return null;
	}

	const exactTestFiles = [...new Set(changedFiles.filter(isBunTestFile))];
	if (exactTestFiles.length > 0) {
		const command = `bun test ${exactTestFiles
			.map((file) => quoteShellArgument(`./${file}`))
			.join(" ")}`;
		return {
			command,
			candidateCommands: [command],
			reason: "Changed test files allow exact Bun test targeting.",
		};
	}

	const packageScopes = [
		...new Set(
			changedFiles
				.map((file) => file.match(/^packages\/([^/]+)\//)?.[1])
				.filter((value): value is string => typeof value === "string"),
		),
	];
	if (packageScopes.length === 1 && packageScopes[0]) {
		const packagePath = `./packages/${packageScopes[0]}`;
		const command = `bun test ${quoteShellArgument(packagePath)}`;
		return {
			command,
			candidateCommands: [command],
			reason: `Changed files stay within packages/${packageScopes[0]}.`,
		};
	}

	return null;
}

async function selectVerificationCommand(
	primaryDirectory: string,
	task: TaskRecord,
): Promise<VerificationSelection> {
	const execution = task.execution;
	const defaultCommand =
		execution?.verification_command ||
		(await detectDefaultVerificationCommand(primaryDirectory));

	if (!execution || !isManagerOwnedCAIDTask(task)) {
		return {
			command: defaultCommand,
			strategy: "fallback",
			candidateCommands: defaultCommand ? [defaultCommand] : [],
			fallbackCommand: defaultCommand,
			reason: "Task is not in the manager-owned CAID workflow.",
		};
	}

	const changedFiles = await listChangedFilesAgainstBase(execution);
	const targeted = selectTargetedVerificationCommand(changedFiles);
	if (targeted?.command) {
		return {
			command: targeted.command,
			strategy: "targeted",
			candidateCommands: targeted.candidateCommands,
			fallbackCommand: defaultCommand,
			reason: targeted.reason,
		};
	}

	return {
		command: defaultCommand,
		strategy: "fallback",
		candidateCommands: defaultCommand ? [defaultCommand] : [],
		fallbackCommand: defaultCommand,
		reason:
			changedFiles.length === 0
				? "No changed files were available for targeted verification derivation."
				: "Could not derive a safe targeted verification scope from the changed files.",
	};
}

async function resyncManagerTaskForRetry(
	primaryDirectory: string,
	state: TaskStateManager,
	task: TaskRecord,
): Promise<{ task?: TaskRecord; error?: string }> {
	if (
		!isManagerOwnedCAIDTask(task) ||
		managerRetryReason(task) !== "merge_conflict"
	) {
		return { task };
	}

	const execution = task.execution;
	if (
		execution?.mode !== "worktree" ||
		!execution.worktree_path ||
		!execution.base_branch
	) {
		return {
			error:
				"Manager retry/resync requires an existing worktree-backed task with a base branch.",
		};
	}

	if (await hasUncommittedChanges(primaryDirectory)) {
		const updated = await state.updateTask(task.id, {
			assignment: buildManagerAssignment(task, {
				retry: {
					reason: "merge_conflict",
					state: "blocked",
					last_resync_status: "failed",
					last_resync_at: new Date().toISOString(),
					last_resync_summary:
						"Repository root is dirty; clean it before retrying the same worker branch.",
				},
			}),
		});
		return {
			task: updated,
			error: "Manager retry is blocked until the repository root is clean.",
		};
	}

	await runGitCommand(["merge", "--abort"], execution.worktree_path).catch(
		() => undefined,
	);
	await runGitCommand(["rebase", "--abort"], execution.worktree_path).catch(
		() => undefined,
	);

	await state.updateTask(task.id, {
		assignment: buildManagerAssignment(task, {
			retry: {
				reason: "merge_conflict",
				state: "resync_required",
				last_resync_status: "pending",
				last_resync_at: new Date().toISOString(),
				last_resync_summary:
					"Replaying latest base branch into the worker worktree.",
			},
		}),
	});

	const merge = await runGitCommand(
		["merge", "--no-edit", execution.base_branch],
		execution.worktree_path,
	);
	const resyncAt = new Date().toISOString();
	if (merge.code !== 0) {
		await runGitCommand(["merge", "--abort"], execution.worktree_path).catch(
			() => undefined,
		);
		const updated = await state.updateTask(task.id, {
			assignment: buildManagerAssignment(task, {
				retry: {
					reason: "merge_conflict",
					state: "blocked",
					last_resync_status: "failed",
					last_resync_at: resyncAt,
					last_resync_summary:
						merge.stderr.trim() || merge.stdout.trim() || "Resync failed.",
				},
			}),
		});
		return {
			task: updated,
			error: merge.stderr.trim() || merge.stdout.trim() || "Resync failed.",
		};
	}

	const updated = await state.updateTask(task.id, {
		execution: {
			...execution,
			merge_status: "pending",
		},
		assignment: buildManagerAssignment(task, {
			retry: {
				reason: "merge_conflict",
				state: "ready",
				last_resync_status: "succeeded",
				last_resync_at: resyncAt,
				last_resync_summary:
					merge.stdout.trim() ||
					"Resynced worker branch with the latest base branch.",
			},
		}),
	});

	return { task: updated };
}

function appendResultNote(result: string | undefined, note: string): string {
	const base = result?.trimEnd();
	return base && base.length > 0 ? `${base}\n\n${note}` : note;
}

async function integrateWorktreeTask(
	primaryDirectory: string,
	state: TaskStateManager,
	task: TaskRecord,
	resultText: string | undefined,
	logger: ReturnType<typeof createLogger>,
): Promise<TaskRecord> {
	const execution = task.execution;
	if (
		execution?.mode !== "worktree" ||
		!execution.worktree_path ||
		!execution.branch ||
		!execution.base_branch
	) {
		if (isManagerReviewPass(task)) {
			await state.updateTask(task.id, {
				assignment: buildManagerAssignment(task, {
					review: {
						status: "complete",
						summary: resultText?.trim() || "Manager review completed.",
						reviewed_at: new Date().toISOString(),
					},
				}),
			});
			return state.transitionTask(task.id, "succeeded", {
				result: appendResultNote(
					resultText,
					"Manager review completed. CAID workflow review gate satisfied.",
				),
			});
		}

		return state.transitionTask(task.id, "succeeded", {
			result: resultText,
		});
	}

	const verificationSelection = await selectVerificationCommand(
		primaryDirectory,
		task,
	);
	const verificationCommand = verificationSelection.command;
	const nextVerificationAssignment = isManagerOwnedCAIDTask(task)
		? buildManagerAssignment(task, {
				verification: {
					...task.assignment?.verification,
					strategy: verificationSelection.strategy,
					candidate_commands: verificationSelection.candidateCommands,
					selected_command: verificationCommand,
					fallback_command: verificationSelection.fallbackCommand,
					selection_reason: verificationSelection.reason,
				},
			})
		: task.assignment;

	if (!verificationCommand) {
		const nextExecution: TaskExecutionRecord = {
			...execution,
			merge_status: "failed",
			verification_status: "failed",
			verification_strategy: verificationSelection.strategy,
			verification_candidates: verificationSelection.candidateCommands,
			verification_fallback_reason:
				verificationSelection.strategy === "fallback"
					? verificationSelection.reason
					: undefined,
			verification_summary: "No default verification command could be derived.",
		};
		await state.updateTask(task.id, {
			execution: nextExecution,
			assignment: nextVerificationAssignment,
		});
		return state.transitionTask(task.id, "failed", {
			result: appendResultNote(
				resultText,
				"Worktree integration failed: no default verification command could be derived.",
			),
			error: "No default verification command could be derived.",
		});
	}

	const worktreeDirty = await hasUncommittedChanges(execution.worktree_path);
	if (worktreeDirty) {
		const snapshot = await runGitCommand(
			["add", "-A"],
			execution.worktree_path,
		);
		if (snapshot.code !== 0) {
			return state.transitionTask(task.id, "failed", {
				result: appendResultNote(
					resultText,
					"Worktree integration failed: unable to stage worker changes.",
				),
				error: snapshot.stderr.trim() || "Failed to stage worker changes.",
			});
		}

		const commit = await runGitCommand(
			[
				"-c",
				"user.name=Op1 Harness",
				"-c",
				"user.email=op1-harness@example.com",
				"commit",
				"-m",
				`chore(task): snapshot ${task.id}`,
			],
			execution.worktree_path,
		);
		if (commit.code !== 0) {
			return state.transitionTask(task.id, "failed", {
				result: appendResultNote(
					resultText,
					"Worktree integration failed: unable to snapshot worker changes.",
				),
				error: commit.stderr.trim() || "Failed to snapshot worker changes.",
			});
		}
	}

	const verification = await runShellCommand(
		verificationCommand,
		execution.worktree_path,
	);
	if (verification.code !== 0) {
		const nextExecution: TaskExecutionRecord = {
			...execution,
			merge_status: "failed",
			verification_status: "failed",
			verification_strategy: verificationSelection.strategy,
			verification_candidates: verificationSelection.candidateCommands,
			verification_fallback_reason:
				verificationSelection.strategy === "fallback"
					? verificationSelection.reason
					: undefined,
			verification_command: verificationCommand,
			verification_summary:
				verification.stderr.trim() || verification.stdout.trim(),
		};
		await state.updateTask(task.id, {
			execution: nextExecution,
			assignment: nextVerificationAssignment,
		});
		return state.transitionTask(task.id, "failed", {
			result: appendResultNote(
				resultText,
				`Verification failed in worktree using \`${verificationCommand}\`.`,
			),
			error: verification.stderr.trim() || "Verification failed.",
		});
	}

	const repoRoot = primaryDirectory;

	if (await hasUncommittedChanges(repoRoot)) {
		const nextExecution: TaskExecutionRecord = {
			...execution,
			merge_status: "dirty_root",
			verification_status: "passed",
			verification_strategy: verificationSelection.strategy,
			verification_candidates: verificationSelection.candidateCommands,
			verification_fallback_reason:
				verificationSelection.strategy === "fallback"
					? verificationSelection.reason
					: undefined,
			verification_command: verificationCommand,
			verification_summary: verification.stdout.trim(),
			retry_count: (execution.retry_count ?? 0) + 1,
		};
		await state.updateTask(task.id, {
			execution: nextExecution,
			assignment: isManagerOwnedCAIDTask(task)
				? buildManagerAssignment(task, {
						verification: nextVerificationAssignment?.verification,
						retry: {
							reason: "dirty_root",
							state: "blocked",
							last_resync_status: undefined,
							last_resync_at: new Date().toISOString(),
							last_resync_summary: "Repository root has uncommitted changes.",
						},
					})
				: nextVerificationAssignment,
		});
		return state.transitionTask(task.id, "blocked", {
			result: appendResultNote(
				resultText,
				"Merge retry required: repository root has uncommitted changes. Clean the root before retrying this task.",
			),
			error: "Repository root has uncommitted changes.",
		});
	}

	const merge = await runGitCommand(
		["merge", "--no-ff", "--no-edit", execution.branch],
		repoRoot,
	);
	if (merge.code !== 0) {
		await runGitCommand(["merge", "--abort"], repoRoot).catch(() => undefined);
		const nextExecution: TaskExecutionRecord = {
			...execution,
			merge_status: "conflicted",
			verification_status: "passed",
			verification_strategy: verificationSelection.strategy,
			verification_candidates: verificationSelection.candidateCommands,
			verification_fallback_reason:
				verificationSelection.strategy === "fallback"
					? verificationSelection.reason
					: undefined,
			verification_command: verificationCommand,
			verification_summary: verification.stdout.trim(),
			retry_count: (execution.retry_count ?? 0) + 1,
		};
		await state.updateTask(task.id, {
			execution: nextExecution,
			assignment: isManagerOwnedCAIDTask(task)
				? buildManagerAssignment(task, {
						verification: nextVerificationAssignment?.verification,
						retry: {
							reason: "merge_conflict",
							state: "resync_required",
							last_resync_status: undefined,
							last_resync_at: new Date().toISOString(),
							last_resync_summary:
								"Merge conflict detected. Resync the same worker branch before retrying.",
						},
					})
				: nextVerificationAssignment,
		});
		logger.warn("Worktree merge conflict routed for retry", {
			task_id: task.id,
			branch: execution.branch,
		});
		return state.transitionTask(task.id, "blocked", {
			result: appendResultNote(
				resultText,
				`Merge conflict on branch ${execution.branch}. Continue the same task to retry in its existing worktree.`,
			),
			error: merge.stderr.trim() || "Merge conflict.",
		});
	}

	const nextExecution: TaskExecutionRecord = {
		...execution,
		merge_status: "merged",
		verification_status: "passed",
		verification_strategy: verificationSelection.strategy,
		verification_candidates: verificationSelection.candidateCommands,
		verification_fallback_reason:
			verificationSelection.strategy === "fallback"
				? verificationSelection.reason
				: undefined,
		verification_command: verificationCommand,
		verification_summary: verification.stdout.trim(),
	};
	const nextAssignment = isManagerOwnedCAIDTask(task)
		? buildManagerAssignment(task, {
				verification: nextVerificationAssignment?.verification,
				retry: clearManagerRetry(task)?.retry,
				review: {
					...task.assignment?.review,
					status: "pending",
					summary:
						"Formal manager review is required before CAID workflow completion.",
				},
			})
		: nextVerificationAssignment;
	await state.updateTask(task.id, {
		execution: nextExecution,
		assignment: nextAssignment,
	});

	if (isManagerOwnedCAIDTask(task)) {
		return state.transitionTask(task.id, "blocked", {
			result: appendResultNote(
				resultText,
				`Verified with \`${verificationCommand}\` and merged branch ${execution.branch} into ${execution.base_branch}. Formal manager review is now pending. Continue the same task with the reviewer agent to complete the workflow.`,
			),
			error: "Manager review pending.",
		});
	}

	return state.transitionTask(task.id, "succeeded", {
		result: appendResultNote(
			resultText,
			`Verified with \`${verificationCommand}\` and merged branch ${execution.branch} into ${execution.base_branch}.`,
		),
	});
}

function getToolCallID(toolCtx: DelegationToolContext): string | null {
	const callID = toolCtx.callID ?? toolCtx.callId ?? toolCtx.call_id;
	if (typeof callID !== "string") return null;
	const trimmed = callID.trim();
	return trimmed.length > 0 ? trimmed : null;
}

async function emitToolMetadata(
	toolCtx: DelegationToolContext,
	toolMetadata: ReturnType<typeof createToolMetadataStore>,
	input: {
		title: string;
		metadata: Record<string, unknown>;
	},
): Promise<void> {
	await toolCtx.metadata?.(input);
	if (!toolCtx.sessionID) return;

	const callID = getToolCallID(toolCtx);
	if (!callID) return;

	toolMetadata.storeToolMetadata(toolCtx.sessionID, callID, input);
}

function mergeToolMetadata(
	output: DelegationToolResult,
	stored: {
		title?: string;
		metadata?: Record<string, unknown>;
	},
): void {
	if (stored.title) {
		output.title = stored.title;
	}

	if (!stored.metadata) return;

	const current =
		output.metadata && typeof output.metadata === "object"
			? output.metadata
			: {};
	output.metadata = {
		...current,
		...stored.metadata,
	};
}

async function emitTaskMetadata(
	toolCtx: DelegationToolContext,
	toolMetadata: ReturnType<typeof createToolMetadataStore>,
	task: TaskRecord,
	title?: string,
): Promise<void> {
	await emitToolMetadata(toolCtx, toolMetadata, {
		title: title ?? task.description,
		metadata: buildTaskToolMetadata(task),
	});
}

function formatTaskMetadata(payload: CanonicalTaskPayload): string {
	const lines = [
		"<task_metadata>",
		`task_id: ${payload.task_id}`,
		`reference: ${payload.reference}`,
		`session_id: ${payload.session_id}`,
	];

	if (payload.execution.mode) {
		lines.push(`execution_mode: ${payload.execution.mode}`);
	}
	if (payload.execution.branch) {
		lines.push(`branch: ${payload.execution.branch}`);
	}
	if (payload.execution.worktree_path) {
		lines.push(`worktree_path: ${payload.execution.worktree_path}`);
	}
	if (payload.execution.verification_strategy) {
		lines.push(
			`verification_strategy: ${payload.execution.verification_strategy}`,
		);
	}
	if (payload.assignment?.review?.status) {
		lines.push(`review_status: ${payload.assignment.review.status}`);
	}
	if (payload.assignment?.retry?.state) {
		lines.push(`retry_state: ${payload.assignment.retry.state}`);
	}

	lines.push("</task_metadata>");
	return lines.join("\n");
}

function formatTaskSummaryLines(payload: CanonicalTaskPayload): string[] {
	const lines = [
		`Task ID: ${payload.task_id}`,
		`Reference: ${payload.reference}`,
		`Session ID: ${payload.session_id}`,
		`Description: ${payload.description}`,
		`Agent: ${payload.agent}`,
		`Execution: ${payload.execution.mode}`,
		`Status: ${payload.status}`,
	];

	if (payload.execution.branch) {
		lines.push(`Branch: ${payload.execution.branch}`);
	}
	if (payload.execution.worktree_path) {
		lines.push(`Worktree: ${payload.execution.worktree_path}`);
	}
	if (payload.assignment?.workflow) {
		lines.push(`Workflow: ${payload.assignment.workflow}`);
	}
	if (payload.execution.verification_strategy) {
		lines.push(`Verification: ${payload.execution.verification_strategy}`);
	}
	if (payload.assignment?.retry?.state) {
		lines.push(
			`Retry: ${payload.assignment.retry.state}${payload.assignment.retry.reason ? ` (${payload.assignment.retry.reason})` : ""}`,
		);
	}
	if (payload.assignment?.review?.status) {
		lines.push(`Review: ${payload.assignment.review.status}`);
	}
	if (payload.error) {
		lines.push(`Error: ${payload.error}`);
	}

	return lines;
}

function formatTaskStatus(task: TaskRecord): string {
	const payload = buildTaskPayload(task);
	return `${formatTaskSummaryLines(payload).join("\n")}\n\n${formatTaskMetadata(payload)}`;
}

function formatBackgroundLaunch(task: TaskRecord): string {
	const payload = buildTaskPayload(task);
	const lines = [
		"Background task launched.",
		"",
		...formatTaskSummaryLines(payload),
	];

	lines.push(
		"",
		`Use \`background_output(task_id="${payload.task_id}")\` to inspect the task.`,
		"",
		formatTaskMetadata(payload),
	);

	return lines.join("\n");
}

function formatSyncCompletion(task: TaskRecord, result: string): string {
	const payload = buildTaskPayload(task);
	return [
		"Task completed.",
		"",
		...formatTaskSummaryLines(payload),
		"",
		"---",
		"",
		result || "(No text output)",
		"",
		formatTaskMetadata(payload),
	].join("\n");
}

async function getRootSessionID(
	client: DelegationClient,
	sessionID?: string,
): Promise<string> {
	if (!sessionID) {
		throw new Error("sessionID is required to resolve root session scope");
	}

	let currentID = sessionID;
	for (let depth = 0; depth < 20; depth += 1) {
		const session = await client.session.get({
			path: { id: currentID },
		});

		const data = asRecord(session.data);
		if (!data) {
			return currentID;
		}

		const parentID = getSessionParentID(data);
		if (!parentID) {
			return currentID;
		}

		currentID = parentID;
	}

	return currentID;
}

async function getRunningCount(
	state: TaskStateManager,
	concurrencyKey: string,
): Promise<number> {
	const running = await state.listTasks({
		status: "running",
		concurrency_key: concurrencyKey,
		run_in_background: true,
		limit: 500,
	});
	return running.length;
}

async function startTaskSession(
	client: DelegationClient,
	task: TaskRecord,
	logger: ReturnType<typeof createLogger>,
): Promise<void> {
	logger.info("Launching background child session", {
		task_id: task.id,
		agent: task.agent,
		child_session_id: task.child_session_id,
	});
	const result = await client.session.promptAsync({
		path: { id: task.child_session_id },
		body: {
			agent: task.agent,
			parts: [{ type: "text", text: task.prompt }],
		},
	});

	if (result.error) {
		logger.warn("Background child session launch failed", {
			task_id: task.id,
			agent: task.agent,
			child_session_id: task.child_session_id,
			error: String(result.error),
		});
		throw new Error(String(result.error));
	}

	logger.info("Background child session launched", {
		task_id: task.id,
		agent: task.agent,
		child_session_id: task.child_session_id,
	});
}

async function promoteRunnableTasks(
	client: DelegationClient,
	state: TaskStateManager,
	logger: ReturnType<typeof createLogger>,
): Promise<void> {
	const candidates = await state.listPromotableTasks({ limit: 100 });

	for (const task of candidates) {
		if (!task.run_in_background) continue;

		const concurrencyKey = task.concurrency_key ?? task.agent;
		const running = await getRunningCount(state, concurrencyKey);
		if (running >= MAX_RUNNING_PER_AGENT) continue;

		try {
			await startTaskSession(client, task, logger);
			await state.transitionTask(task.id, "running");
		} catch (error) {
			await state.transitionTask(task.id, "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return;
}

async function getLatestAssistantResult(
	client: DelegationClient,
	sessionID: string,
): Promise<string | null> {
	const response = await client.session.messages({
		path: { id: sessionID },
		query: { limit: 40 },
	});
	return extractLatestAssistantText(response.data);
}

async function getSessionStatus(
	client: DelegationClient,
	sessionID: string,
): Promise<string | undefined> {
	if (!client.session.status) return undefined;

	const result = await client.session.status({
		path: { id: sessionID },
	});
	if (!result.data || typeof result.data !== "object") return undefined;

	const data = result.data as Record<string, unknown>;
	const direct = data[sessionID];
	const directStatus = readSessionStatusValue(direct);
	if (directStatus) {
		return directStatus;
	}

	return readSessionStatusValue(data);
}

async function refreshTaskFromRuntime(
	client: DelegationClient,
	state: TaskStateManager,
	primaryDirectory: string,
	task: TaskRecord,
	logger: ReturnType<typeof createLogger>,
): Promise<TaskRecord> {
	if (task.status !== "running") return task;

	const status = await getSessionStatus(client, task.child_session_id);
	if (status === "idle") {
		const result = await getLatestAssistantResult(
			client,
			task.child_session_id,
		);
		return integrateWorktreeTask(
			primaryDirectory,
			state,
			task,
			result ?? undefined,
			logger,
		);
	}

	if (status === "error") {
		return state.transitionTask(task.id, "failed", {
			error: "Task session reported an error.",
		});
	}

	return task;
}

async function resolveTaskByHandle(
	state: TaskStateManager,
	handle: string,
): Promise<TaskRecord | null> {
	const trimmed = handle.trim();
	if (!trimmed) return null;
	return state.getTask(trimmed);
}

async function resolveScopedTask(
	client: DelegationClient,
	state: TaskStateManager,
	handle: string,
	toolCtx: DelegationToolContext,
): Promise<TaskRecord | null> {
	if (!toolCtx.sessionID) {
		throw new Error("sessionID is required for task resolution.");
	}

	const task = await resolveTaskByHandle(state, handle);
	if (!task) return null;

	const rootSessionID = await getRootSessionID(client, toolCtx.sessionID);
	if (task.root_session_id !== rootSessionID) {
		return null;
	}

	return task;
}

async function askForTaskPermission(
	toolCtx: DelegationToolContext,
	input: {
		description: string;
		agent: string;
		category?: DelegationCategory;
		auto_route: boolean;
	},
): Promise<void> {
	if (!toolCtx.ask) return;

	await toolCtx.ask({
		permission: "task",
		patterns: [input.agent],
		always: ["*"],
		metadata: {
			description: input.description,
			subagent_type: input.agent,
			auto_route: input.auto_route,
			...(input.category ? { category: input.category } : {}),
		},
	});
}

export const DelegationPlugin: Plugin = async (ctx: {
	directory: string;
	client: unknown;
}) => {
	const workspaceDir = join(ctx.directory, ".opencode", "workspace");
	await mkdir(workspaceDir, { recursive: true });

	const client = ctx.client as unknown as DelegationClient;
	const sink = async (entry: {
		service: string;
		level: string;
		message: string;
		extra?: Record<string, unknown>;
	}) => {
		await client.app?.log?.({
			body: entry,
		});
	};
	const logger = createLogger("delegation.plugin", sink);
	const state = createTaskStateManager(
		workspaceDir,
		createLogger("delegation.state", sink),
	);
	const toolMetadata = createToolMetadataStore();
	let availableAgentsPromise: Promise<Map<
		string,
		{ mode?: string }
	> | null> | null = null;
	let promotionQueue: Promise<void> = Promise.resolve();

	const queuePromotionPass = async (): Promise<void> => {
		const nextPass = promotionQueue
			.catch(() => undefined)
			.then(() => promoteRunnableTasks(client, state, logger));
		promotionQueue = nextPass.catch(() => undefined);
		return nextPass;
	};

	const getAvailableAgents = async (): Promise<Map<
		string,
		{ mode?: string }
	> | null> => {
		if (availableAgentsPromise) return availableAgentsPromise;

		availableAgentsPromise = (async () => {
			try {
				const response = await client.app?.agents?.();
				if (!Array.isArray(response?.data)) return null;

				const agents = new Map<string, { mode?: string }>();
				for (const entry of response.data) {
					if (!entry || typeof entry !== "object") continue;
					const name =
						typeof entry.name === "string" && entry.name.trim().length > 0
							? entry.name.trim()
							: null;
					if (!name) continue;
					agents.set(name, {
						mode:
							typeof entry.mode === "string" && entry.mode.trim().length > 0
								? entry.mode
								: undefined,
					});
				}

				return agents.size > 0 ? agents : null;
			} catch (error) {
				logger.warn("Agent discovery failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}
		})();

		return availableAgentsPromise;
	};

	const ensureAgentAvailable = async (agent: string): Promise<void> => {
		const availableAgents = await getAvailableAgents();
		if (!availableAgents) return;
		if (availableAgents.has(agent)) return;

		const available = [...availableAgents.entries()]
			.map(([name, details]) =>
				typeof details.mode === "string" ? `${name} (${details.mode})` : name,
			)
			.sort()
			.join(", ");

		throw new Error(
			`Agent '${agent}' is not available. Available agents: ${available || "none"}.`,
		);
	};

	const event = async (payload: { event?: unknown }) => {
		let taskID: string | null = null;
		try {
			if (!payload.event || typeof payload.event !== "object") return;

			const runtimeEvent = payload.event as RuntimeEvent;
			if (
				runtimeEvent.type !== "session.idle" &&
				runtimeEvent.type !== "session.error" &&
				runtimeEvent.type !== "session.deleted" &&
				runtimeEvent.type !== "session.interrupt"
			) {
				return;
			}

			const sessionID = getEventSessionID(runtimeEvent);
			if (!sessionID) return;

			const task = await state.getTaskByChildSessionID(sessionID);
			if (!task || task.status !== "running") return;
			taskID = task.id;

			if (runtimeEvent.type === "session.idle") {
				const result = await getLatestAssistantResult(client, sessionID);
				await integrateWorktreeTask(
					ctx.directory,
					state,
					task,
					result ?? undefined,
					logger,
				);
				await queuePromotionPass();
				return;
			}

			if (runtimeEvent.type === "session.error") {
				await state.transitionTask(task.id, "failed", {
					error: getEventError(runtimeEvent),
				});
				await queuePromotionPass();
				return;
			}

			await state.transitionTask(task.id, "cancelled", {
				error:
					runtimeEvent.type === "session.interrupt"
						? "Task session interrupted."
						: "Task session deleted.",
			});
			await queuePromotionPass();
		} catch (error) {
			if (taskID) {
				const current = await state.getTask(taskID).catch(() => null);
				if (
					current &&
					(current.status === "cancelled" ||
						current.status === "failed" ||
						current.status === "succeeded")
				) {
					return;
				}
			}

			logger.warn("Task event handling failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const toolExecuteAfter = async (
		input: DelegationToolExecuteAfterInput,
		output: DelegationToolResult | undefined,
	) => {
		if (!output) return;

		const stored = toolMetadata.consumeToolMetadata(
			input.sessionID,
			input.callID,
		);
		if (!stored) return;

		mergeToolMetadata(output, stored);
	};

	return {
		event,
		"tool.execute.after": toolExecuteAfter,
		tool: {
			task: tool({
				description:
					"Launch a subagent task, optionally run it in the background, and return a durable task id plus child session metadata.",
				args: {
					description: tool.schema
						.string()
						.describe("A short (3-5 words) description of the task"),
					prompt: tool.schema
						.string()
						.describe("The task for the agent to perform"),
					subagent_type: tool.schema
						.string()
						.optional()
						.describe("The type of specialized agent to use for this task"),
					task_id: tool.schema
						.string()
						.optional()
						.describe(
							"Optional durable task id for a fresh task launch. Omit to let the tool generate one. If a compatibility wrapper still requires this field, pass an empty string and never invent a new durable id.",
						),
					continue_task_id: tool.schema
						.string()
						.optional()
						.describe(
							"Explicit durable task id to resume or restart a prior task.",
						),
					command: tool.schema
						.string()
						.optional()
						.describe("The command that triggered this task"),
					run_in_background: tool.schema
						.boolean()
						.optional()
						.describe(
							"Run asynchronously and inspect later with background_output (default: false).",
						),
					category: tool.schema
						.string()
						.optional()
						.describe("Optional routing category for default-agent selection."),
					auto_route: tool.schema
						.boolean()
						.optional()
						.describe(
							"Enable keyword-based agent routing when subagent_type is omitted.",
						),
				},
				async execute(rawArgs: unknown, rawToolCtx: unknown) {
					const args = rawArgs as TaskToolArgs;
					const toolCtx = rawToolCtx as DelegationToolContext;

					if (!toolCtx.sessionID) {
						return "❌ task requires sessionID. This is a system error.";
					}

					const description = args.description.trim();
					const prompt = args.prompt.trim();
					if (!description) return "❌ description is required.";
					if (!prompt) return "❌ prompt is required.";
					if (args.task_id?.trim() && args.continue_task_id?.trim()) {
						return "❌ Provide either task_id for a new launch or continue_task_id to resume an existing task, not both.";
					}

					const runInBackground = args.run_in_background === true;
					const requestedTaskID = args.task_id?.trim() || undefined;
					const explicitContinueTaskID =
						args.continue_task_id?.trim() || undefined;
					const requestedCategory = parseDelegationCategory(
						args.category?.trim(),
					);
					const autoRoute = args.auto_route === true;

					let agent = args.subagent_type?.trim() ?? "";
					let category: DelegationCategory | undefined;
					let routing: DelegationRoutingTelemetry | undefined;

					if (!agent && !requestedCategory && !autoRoute) {
						return "❌ Provide subagent_type, or set category/auto_route for routed execution.";
					}

					if (!agent || requestedCategory || autoRoute) {
						const decision = resolveDelegationRouting({
							description,
							prompt,
							command: args.command?.trim(),
							category: requestedCategory ?? undefined,
							subagentType: agent || undefined,
							autoRoute,
						});
						agent = decision.agent;
						category = decision.telemetry.detected_category;
						routing = decision.telemetry;
					}

					try {
						await ensureAgentAvailable(agent);
					} catch (error) {
						return `❌ ${error instanceof Error ? error.message : String(error)}`;
					}

					logger.info("Delegation task resolved", {
						description,
						agent,
						category,
						auto_route: autoRoute,
						run_in_background: runInBackground,
						requested_task_id: requestedTaskID,
						continue_task_id: explicitContinueTaskID,
						fallback_path: routing?.fallback_path,
						confidence: routing?.confidence,
					});

					await askForTaskPermission(toolCtx, {
						description,
						agent,
						category,
						auto_route: autoRoute,
					});

					const rootSessionID = await getRootSessionID(
						client,
						toolCtx.sessionID,
					);
					const concurrencyKey = agent;

					let childSessionID: string | null = null;
					let task: TaskRecord;

					const shouldRestartExisting =
						typeof explicitContinueTaskID === "string" &&
						explicitContinueTaskID.length > 0;

					if (shouldRestartExisting) {
						let existing = await resolveScopedTask(
							client,
							state,
							explicitContinueTaskID,
							toolCtx,
						);
						if (existing) {
							const canResumeBlockedManagerTask =
								existing.status === "blocked" &&
								isManagerOwnedCAIDTask(existing);
							if (
								isActiveTask(existing.status) &&
								!canResumeBlockedManagerTask
							) {
								return `❌ Task ${existing.id} is already active.`;
							}

							if (
								isManagerOwnedCAIDTask(existing) &&
								isManagerReviewPending(existing)
							) {
								if (agent !== "reviewer") {
									return '❌ Manager review is pending. Continue this CAID task with subagent_type="reviewer".';
								}

								existing =
									(await state.updateTask(existing.id, {
										assignment: buildManagerAssignment(existing, {
											review: {
												...existing.assignment?.review,
												status: "running",
											},
										}),
									})) ?? existing;
							}

							if (
								isManagerOwnedCAIDTask(existing) &&
								managerRetryState(existing) === "resync_required"
							) {
								const resync = await resyncManagerTaskForRetry(
									ctx.directory,
									state,
									existing,
								);
								if (resync.error) {
									return `❌ ${resync.error}`;
								}
								if (resync.task) {
									existing = resync.task;
								}
							}

							if (
								isManagerOwnedCAIDTask(existing) &&
								managerRetryReason(existing) === "dirty_root" &&
								managerRetryState(existing) === "blocked"
							) {
								if (await hasUncommittedChanges(ctx.directory)) {
									return "❌ Manager retry is blocked until the repository root is clean.";
								}

								existing = await state.updateTask(existing.id, {
									execution: existing.execution
										? {
												...existing.execution,
												merge_status: "pending",
											}
										: existing.execution,
									assignment: clearManagerRetry(existing),
								});
							}

							const execution = await prepareTaskExecution(
								ctx.directory,
								{
									taskID: existing.id,
									agent,
									existing: existing.execution,
								},
								logger,
							);
							childSessionID = await createChildSessionForTask(
								client,
								{
									description,
									agent,
									parent_session_id: toolCtx.sessionID,
									directory: execution.worktree_path,
								},
								logger,
							);

							task = await state.restartTask({
								id: existing.id,
								child_session_id: childSessionID,
								description,
								prompt,
								command: args.command?.trim(),
								category,
								routing,
								concurrency_key: concurrencyKey,
								assignment: existing.assignment,
								execution,
								run_in_background: runInBackground,
								initial_status: runInBackground ? "queued" : "running",
							});
						} else {
							return `❌ Task not found: ${explicitContinueTaskID}`;
						}
					} else {
						const taskID = requestedTaskID || (await generateTaskID(state));
						const execution = await prepareTaskExecution(
							ctx.directory,
							{ taskID, agent },
							logger,
						);
						childSessionID = await createChildSessionForTask(
							client,
							{
								description,
								agent,
								parent_session_id: toolCtx.sessionID,
								directory: execution.worktree_path,
							},
							logger,
						);

						task = await state.createTask({
							id: taskID,
							root_session_id: rootSessionID,
							parent_session_id: toolCtx.sessionID,
							child_session_id: childSessionID,
							description,
							agent,
							prompt,
							command: args.command?.trim(),
							category,
							routing,
							concurrency_key: concurrencyKey,
							execution,
							run_in_background: runInBackground,
							initial_status: runInBackground ? "queued" : "running",
						});
					}

					if (runInBackground) {
						await queuePromotionPass();
						const latest = (await state.getTask(task.id)) ?? task;
						await emitTaskMetadata(toolCtx, toolMetadata, latest, description);
						return formatBackgroundLaunch(latest);
					}

					try {
						logger.info("Launching sync child session", {
							task_id: task.id,
							agent: task.agent,
							child_session_id: task.child_session_id,
						});
						const response = await client.session.prompt({
							path: { id: task.child_session_id },
							body: {
								agent,
								parts: [{ type: "text", text: prompt }],
							},
						});
						if (response.error) {
							logger.warn("Sync child session failed", {
								task_id: task.id,
								agent: task.agent,
								child_session_id: task.child_session_id,
								error: String(response.error),
							});
							const failed = await state.transitionTask(task.id, "failed", {
								error: String(response.error),
							});
							await emitTaskMetadata(
								toolCtx,
								toolMetadata,
								failed,
								description,
							);
							return `❌ Task failed.\n\n${formatTaskStatus(failed)}`;
						}

						const resultText =
							extractPromptResponseText(response.data) ??
							(await getLatestAssistantResult(client, task.child_session_id)) ??
							"";
						const succeeded = await integrateWorktreeTask(
							ctx.directory,
							state,
							task,
							resultText || undefined,
							logger,
						);
						logger.info("Sync child session completed", {
							task_id: task.id,
							agent: task.agent,
							child_session_id: task.child_session_id,
						});
						await emitTaskMetadata(
							toolCtx,
							toolMetadata,
							succeeded,
							description,
						);
						return formatSyncCompletion(
							succeeded,
							succeeded.result ?? resultText,
						);
					} catch (error) {
						logger.warn("Sync child session threw", {
							task_id: task.id,
							agent: task.agent,
							child_session_id: task.child_session_id,
							error: error instanceof Error ? error.message : String(error),
						});
						const failed = await state.transitionTask(task.id, "failed", {
							error: error instanceof Error ? error.message : String(error),
						});
						await emitTaskMetadata(toolCtx, toolMetadata, failed, description);
						return `❌ Task failed.\n\n${formatTaskStatus(failed)}`;
					}
				},
			}),

			background_output: tool({
				description:
					"Read the latest status or transcript for a background task using its durable task id.",
				args: {
					task_id: tool.schema.string().describe("Durable task id."),
					block: tool.schema
						.boolean()
						.optional()
						.describe("Wait for completion before returning output."),
					timeout: tool.schema
						.number()
						.optional()
						.describe(
							"Maximum time to wait when block=true (default: 60000ms).",
						),
					full_session: tool.schema
						.boolean()
						.optional()
						.describe(
							"Return the recent session transcript instead of summary status.",
						),
					include_thinking: tool.schema
						.boolean()
						.optional()
						.describe("Include reasoning parts in full_session output."),
					include_tool_results: tool.schema
						.boolean()
						.optional()
						.describe("Include tool outputs in full_session output."),
					message_limit: tool.schema
						.number()
						.optional()
						.describe("Maximum number of messages to include."),
				},
				async execute(rawArgs: unknown, rawToolCtx: unknown) {
					const args = rawArgs as BackgroundOutputArgs;
					const toolCtx = rawToolCtx as DelegationToolContext;
					const task = await resolveScopedTask(
						client,
						state,
						args.task_id,
						toolCtx,
					).catch(
						(error) =>
							`❌ ${error instanceof Error ? error.message : String(error)}`,
					);

					if (typeof task === "string") return task;
					if (!task) return `❌ Task not found: ${args.task_id}`;

					let current = task;
					if (args.block === true) {
						const timeoutMs = Math.min(
							Math.max(
								1000,
								Math.floor(args.timeout ?? DEFAULT_BLOCK_TIMEOUT_MS),
							),
							10 * 60 * 1000,
						);
						const deadline = Date.now() + timeoutMs;
						while (isActiveTask(current.status) && Date.now() < deadline) {
							current = await refreshTaskFromRuntime(
								client,
								state,
								ctx.directory,
								current,
								logger,
							);
							if (!isActiveTask(current.status)) break;
							await sleep(1000);
							const latest = await state.getTask(current.id);
							if (latest) current = latest;
						}
					}

					await emitTaskMetadata(toolCtx, toolMetadata, current);

					if (args.full_session !== false) {
						const response = await client.session.messages({
							path: { id: current.child_session_id },
							query: { limit: args.message_limit },
						});
						return formatFullSession(response.data, {
							task: current,
							includeThinking: args.include_thinking,
							includeToolResults: args.include_tool_results,
							messageLimit: args.message_limit,
						});
					}

					if (current.status === "succeeded" && current.result) {
						return formatSyncCompletion(current, current.result);
					}

					return formatTaskStatus(current);
				},
			}),

			background_cancel: tool({
				description:
					"Cancel one active background task by durable task id, or cancel all active background tasks in the current root session.",
				args: {
					task_id: tool.schema
						.string()
						.optional()
						.describe("Durable task id to cancel."),
					all: tool.schema
						.boolean()
						.optional()
						.describe(
							"Cancel all active background tasks in the current root session.",
						),
					reason: tool.schema
						.string()
						.optional()
						.describe("Optional cancellation reason."),
				},
				async execute(rawArgs: unknown, rawToolCtx: unknown) {
					const args = rawArgs as BackgroundCancelArgs;
					const toolCtx = rawToolCtx as DelegationToolContext;
					if (!toolCtx.sessionID) {
						return "❌ background_cancel requires sessionID. This is a system error.";
					}

					const rootSessionID = await getRootSessionID(
						client,
						toolCtx.sessionID,
					);

					const reasonText = args.reason?.trim();
					if (args.all === true) {
						const tasks = await state.listTasks({
							root_session_id: rootSessionID,
							limit: 500,
							run_in_background: true,
						});
						const active = tasks.filter((task) => isActiveTask(task.status));
						if (active.length === 0) {
							return "No active background tasks to cancel.";
						}

						const cancelled: TaskRecord[] = [];
						for (const task of active) {
							if (task.status === "running") {
								await client.session
									.abort({
										path: { id: task.child_session_id },
									})
									.catch(() => undefined);
							}
							cancelled.push(
								await state.transitionTask(task.id, "cancelled", {
									error: reasonText
										? `Cancelled: ${reasonText}`
										: "Task cancelled by user request.",
								}),
							);
						}

						await queuePromotionPass();
						await emitToolMetadata(toolCtx, toolMetadata, {
							title: "Cancelled background tasks",
							metadata: buildTaskCollectionMetadata(cancelled),
						});
						return [
							`Cancelled ${cancelled.length} background task(s):`,
							...cancelled.map(
								(task) =>
									`- ${task.id} (${task.agent}) -> ${task.child_session_id}`,
							),
						].join("\n");
					}

					const handle = args.task_id?.trim();
					if (!handle) {
						return "❌ Provide task_id, or set all=true.";
					}

					const task = await resolveScopedTask(client, state, handle, toolCtx);
					if (!task) return `❌ Task not found: ${handle}`;
					if (!isActiveTask(task.status)) {
						await emitTaskMetadata(toolCtx, toolMetadata, task);
						return formatTaskStatus(task);
					}

					if (task.status === "running") {
						await client.session
							.abort({
								path: { id: task.child_session_id },
							})
							.catch(() => undefined);
					}

					const cancelled = await state.transitionTask(task.id, "cancelled", {
						error: reasonText
							? `Cancelled: ${reasonText}`
							: "Task cancelled by user request.",
					});
					await queuePromotionPass();
					await emitTaskMetadata(toolCtx, toolMetadata, cancelled);
					return formatTaskStatus(cancelled);
				},
			}),

			agent_status: tool({
				description:
					"Read-only health summary for current root session using background-task signals (healthy|degraded|stuck).",
				args: {
					stuck_after_ms: tool.schema.number().int().min(1000).optional(),
					queue_degraded_after_ms: tool.schema
						.number()
						.int()
						.min(1000)
						.optional(),
					failure_window_ms: tool.schema.number().int().min(1000).optional(),
					limit: tool.schema.number().int().min(1).max(300).optional(),
				},
				async execute(args: unknown, rawToolCtx: unknown) {
					const toolCtx = rawToolCtx as DelegationToolContext;
					if (!toolCtx.sessionID) {
						return "❌ agent_status requires sessionID. This is a system error.";
					}

					const rootSessionID = await getRootSessionID(
						client,
						toolCtx.sessionID,
					);
					const tasks = await state.listTasks({
						root_session_id: rootSessionID,
						limit: (args as { limit?: number }).limit ?? 100,
					});
					const snapshot = summarizeAgentStatus(tasks, {
						nowMs: Date.now(),
						stuckAfterMs: (args as { stuck_after_ms?: number }).stuck_after_ms,
						queueDegradedAfterMs: (args as { queue_degraded_after_ms?: number })
							.queue_degraded_after_ms,
						failureWindowMs: (args as { failure_window_ms?: number })
							.failure_window_ms,
					});

					return JSON.stringify(
						{
							root_session_id: rootSessionID,
							...snapshot,
						},
						null,
						2,
					);
				},
			}),

			task_graph_status: tool({
				description:
					"Inspect task graph status with blocked-task metadata for durable delegation records.",
				args: {
					root_session_id: tool.schema.string().optional(),
					include_completed: tool.schema.boolean().optional(),
					limit: tool.schema.number().int().min(1).max(500).optional(),
				},
				async execute(args: unknown, rawToolCtx: unknown) {
					const toolCtx = rawToolCtx as DelegationToolContext;
					const input = args as {
						root_session_id?: string;
						include_completed?: boolean;
						limit?: number;
					};

					if (!input.root_session_id && !toolCtx.sessionID) {
						return "❌ task_graph_status requires sessionID when root_session_id is omitted.";
					}

					const rootSessionID = input.root_session_id
						? input.root_session_id
						: await getRootSessionID(client, toolCtx.sessionID);
					const tasks = await state.listTasks({
						root_session_id: rootSessionID,
						limit: input.limit ?? 200,
					});
					const graph = buildTaskGraph(tasks, {
						includeCompleted: input.include_completed ?? true,
					});

					return JSON.stringify(
						{
							root_session_id: rootSessionID,
							...graph,
						},
						null,
						2,
					);
				},
			}),
		},
	};
};

export default DelegationPlugin;

export type {
	AgentHealthStatus,
	AgentStatusEvidence,
} from "./agent-status.js";
export type {
	TaskRecord,
	TaskStateManager,
	TaskStatus,
} from "./state.js";
export type {
	TaskGraphEdge,
	TaskGraphNode,
	TaskGraphSnapshot,
} from "./task-graph.js";
