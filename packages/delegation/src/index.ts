import { copyFile, lstat, stat } from "node:fs/promises";
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
	summarizeSessionActivity,
} from "./messages.js";
import {
	type DelegationCategory,
	type DelegationRoutingTelemetry,
	looksReadOnlyDelegationIntent,
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
const TINY_FRONTEND_EDIT_OR_BLOCKED_THRESHOLD = 6;
const TINY_FRONTEND_AUTHORITATIVE_CONTEXT_THRESHOLD = 10;

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

function isTerminalTask(status: TaskStatus): boolean {
	return (
		status === "succeeded" || status === "failed" || status === "cancelled"
	);
}

function shouldAttemptRootFollowThrough(status: TaskStatus): boolean {
	return status === "blocked" || isTerminalTask(status);
}

function buildChildPrompt(task: TaskRecord): string {
	const authoritativeContext = task.authoritative_context?.trim();
	if (!authoritativeContext) return task.prompt;

	return [
		"<authoritative_context>",
		authoritativeContext,
		"</authoritative_context>",
		"",
		"Treat <authoritative_context> as the approved working set for this task.",
		"Run only a short mismatch re-check before editing (1-2 targeted reads/searches).",
		"If the context mismatches repo reality after that short re-check, return an explicit blocked result with the mismatch instead of broad rediscovery.",
		"",
		task.prompt,
	].join("\n");
}

function extractInlineAuthoritativeContext(input: {
	prompt: string;
	authoritativeContext?: string;
}): {
	prompt: string;
	authoritativeContext?: string;
} {
	const explicitContext = input.authoritativeContext?.trim();
	if (explicitContext) {
		return {
			prompt: input.prompt.trim(),
			authoritativeContext: explicitContext,
		};
	}

	const taggedMatch = input.prompt.match(
		/<authoritative_context>\s*([\s\S]*?)\s*<\/authoritative_context>/i,
	);
	if (taggedMatch) {
		const extracted = taggedMatch[1]?.trim();
		const strippedPrompt = input.prompt
			.replace(taggedMatch[0], "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return {
			prompt: strippedPrompt,
			authoritativeContext: extracted || undefined,
		};
	}

	const labeledMatch = input.prompt.match(
		/(?:^|\n{2,})(?:authoritative[_ ]context)\s*:\s*\n([\s\S]+)$/i,
	);
	if (labeledMatch) {
		const extracted = labeledMatch[1]?.trim();
		const strippedPrompt = input.prompt
			.slice(0, labeledMatch.index)
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return {
			prompt: strippedPrompt,
			authoritativeContext: extracted || undefined,
		};
	}

	return {
		prompt: input.prompt.trim(),
		authoritativeContext: undefined,
	};
}

function getAuthoritativeContextExtractionTelemetry(input: {
	prompt: string;
	authoritativeContext?: string;
}): {
	source: "explicit" | "tagged" | "labeled" | "none";
	prompt_preview: string;
	has_authoritative_context: boolean;
} {
	const explicitContext = input.authoritativeContext?.trim();
	if (explicitContext) {
		return {
			source: "explicit",
			prompt_preview: input.prompt.slice(0, 120),
			has_authoritative_context: true,
		};
	}

	if (
		/<authoritative_context>\s*[\s\S]*?\s*<\/authoritative_context>/i.test(
			input.prompt,
		)
	) {
		return {
			source: "tagged",
			prompt_preview: input.prompt.slice(0, 120),
			has_authoritative_context: true,
		};
	}

	if (
		/(?:^|\n{2,})(?:authoritative[_ ]context)\s*:\s*\n([\s\S]+)$/i.test(
			input.prompt,
		)
	) {
		return {
			source: "labeled",
			prompt_preview: input.prompt.slice(0, 120),
			has_authoritative_context: true,
		};
	}

	return {
		source: "none",
		prompt_preview: input.prompt.slice(0, 120),
		has_authoritative_context: false,
	};
}

function withInitialRootFollowThrough(
	execution: TaskExecutionRecord,
	runInBackground: boolean,
): TaskExecutionRecord {
	if (!runInBackground) return execution;

	return {
		...execution,
		root_follow_through: {
			status: "pending",
			updated_at: new Date().toISOString(),
			source: "launch",
		},
	};
}

async function readContinuationMode(
	workspaceDir: string,
	sessionID: string,
): Promise<"running" | "stopped" | "handoff"> {
	const stateFile = Bun.file(join(workspaceDir, "continuation.json"));
	if (!(await stateFile.exists())) return "running";

	try {
		const parsed = (await stateFile.json()) as {
			sessions?: Record<string, { mode?: unknown }>;
		};
		const mode = parsed.sessions?.[sessionID]?.mode;
		if (mode === "stopped" || mode === "handoff") return mode;
	} catch {
		return "running";
	}

	return "running";
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

async function buildUnsafeDependencyBootstrapMessage(
	worktreePath: string,
): Promise<string> {
	const nodeModulesPath = join(worktreePath, "node_modules");
	return [
		`Unsafe worktree dependency bootstrap detected at ${nodeModulesPath}.`,
		"Cause: node_modules must be a real directory inside the worktree, not a shared symlink or non-directory entry.",
		"To fix:",
		`1. rm -rf ${nodeModulesPath}`,
		`2. From ${worktreePath}, run the repo's dependency install command using the repo's package manager/tooling.`,
		"3. Re-run the task.",
	].join("\n");
}

async function getUnsafeDependencyBootstrapMessage(
	worktreePath: string,
): Promise<string | undefined> {
	const nodeModulesPath = join(worktreePath, "node_modules");
	try {
		const info = await lstat(nodeModulesPath);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			return buildUnsafeDependencyBootstrapMessage(worktreePath);
		}
	} catch (error) {
		const code =
			error instanceof Error && "code" in error
				? (error as { code?: string }).code
				: undefined;
		if (code !== "ENOENT") {
			return buildUnsafeDependencyBootstrapMessage(worktreePath);
		}
	}

	return undefined;
}

function shouldUseDirectExecution(input: {
	agent: string;
	category?: DelegationCategory;
	description?: string;
	prompt?: string;
	command?: string;
}): boolean {
	if (!isWorktreeEligibleAgent(input.agent)) {
		return true;
	}

	if (input.category === "research" || input.category === "review") {
		return true;
	}

	return looksReadOnlyDelegationIntent(
		[input.description ?? "", input.prompt ?? "", input.command ?? ""].join(
			"\n",
		),
	);
}

async function prepareTaskExecution(
	directory: string,
	input: {
		taskID: string;
		agent: string;
		category?: DelegationCategory;
		description?: string;
		prompt?: string;
		command?: string;
		existing?: TaskExecutionRecord;
	},
	logger: ReturnType<typeof createLogger>,
): Promise<TaskExecutionRecord> {
	if (shouldUseDirectExecution(input)) {
		return {
			mode: "direct",
			merge_status: "bypassed",
			effective_root_path: directory,
		};
	}

	if (
		input.existing?.mode === "worktree" &&
		input.existing.worktree_path &&
		(await pathExists(input.existing.worktree_path))
	) {
		const unsafeExisting = await getUnsafeDependencyBootstrapMessage(
			input.existing.worktree_path,
		);
		if (unsafeExisting) {
			throw new Error(unsafeExisting);
		}

		return {
			...input.existing,
			effective_root_path:
				input.existing.effective_root_path ?? input.existing.worktree_path,
		};
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
		return {
			mode: "direct",
			merge_status: "bypassed",
			effective_root_path: directory,
		};
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
		return {
			mode: "direct",
			merge_status: "bypassed",
			effective_root_path: repoRoot,
		};
	}

	const branch = sanitizeBranchName(`op1/${input.agent}/${input.taskID}`);
	if (!branch) {
		return {
			mode: "direct",
			merge_status: "bypassed",
			effective_root_path: repoRoot,
		};
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
			return {
				mode: "direct",
				merge_status: "bypassed",
				effective_root_path: repoRoot,
			};
		}

		await Promise.all([
			copyIfExists(join(repoRoot, ".env"), join(worktreePath, ".env")),
			copyIfExists(
				join(repoRoot, ".env.local"),
				join(worktreePath, ".env.local"),
			),
		]);
	}

	const unsafeBootstrap =
		await getUnsafeDependencyBootstrapMessage(worktreePath);
	if (unsafeBootstrap) {
		throw new Error(unsafeBootstrap);
	}

	return {
		mode: "worktree",
		branch,
		base_branch: baseBranch,
		worktree_path: worktreePath,
		effective_root_path: worktreePath,
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

function hasExplicitScopeHint(text: string): boolean {
	return (
		/(?:^|\s)(?:[\w.-]+\/)+[\w.-]+(?:\.[\w-]+)?/.test(text) ||
		/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/.test(text) ||
		/\b(page|screen|component|dialog|modal|form|button|route)\b/i.test(text)
	);
}

function isTinyFrontendImplementationTask(task: TaskRecord): boolean {
	if (task.agent !== "frontend") return false;
	if (
		task.category === "research" ||
		task.category === "planning" ||
		task.category === "deep"
	) {
		return false;
	}

	const text = `${task.description}\n${task.prompt}`;
	if (
		/\b(research|investigate|compare|explore|audit|architecture|plan|strategy|roadmap|entire|all screens|all pages|system)\b/i.test(
			text,
		)
	) {
		return false;
	}

	if (task.category === "quick") return true;
	return text.length <= 1200 && hasExplicitScopeHint(text);
}

async function getSessionTranscriptData(
	client: DelegationClient,
	sessionID: string,
): Promise<unknown> {
	const response = await client.session.messages({
		path: { id: sessionID },
		query: { limit: 120 },
	});
	return response.data;
}

function hasExecutionTelemetryChanged(
	current: TaskExecutionRecord | undefined,
	next: TaskExecutionRecord,
): boolean {
	if (!current) return true;

	return (
		current.effective_root_path !== next.effective_root_path ||
		current.verification_summary !== next.verification_summary ||
		current.diff_summary !== next.diff_summary ||
		current.root_follow_through?.status !== next.root_follow_through?.status ||
		current.root_follow_through?.reason !== next.root_follow_through?.reason ||
		current.read_count !== next.read_count ||
		current.search_count !== next.search_count ||
		current.planning_count !== next.planning_count ||
		current.edit_count !== next.edit_count ||
		current.other_count !== next.other_count ||
		current.file_changed !== next.file_changed ||
		current.edit_or_blocked_threshold !== next.edit_or_blocked_threshold ||
		current.stale_reason !== next.stale_reason
	);
}

function getTinyFrontendThreshold(task: TaskRecord): number {
	if (!isTinyFrontendImplementationTask(task)) {
		return (
			task.execution?.edit_or_blocked_threshold ??
			TINY_FRONTEND_EDIT_OR_BLOCKED_THRESHOLD
		);
	}

	return task.authoritative_context
		? TINY_FRONTEND_AUTHORITATIVE_CONTEXT_THRESHOLD
		: TINY_FRONTEND_EDIT_OR_BLOCKED_THRESHOLD;
}

async function buildDiffSummary(task: TaskRecord): Promise<string> {
	const execution = task.execution;
	if (execution?.diff_summary?.trim()) return execution.diff_summary.trim();
	if (!execution) return "Diff summary unavailable.";

	if (execution.mode === "worktree") {
		const changedFiles = await listChangedFilesAgainstBase(execution);
		if (changedFiles.length > 0) {
			const visibleFiles = changedFiles.slice(0, 5).join(", ");
			const hiddenCount =
				changedFiles.length - Math.min(changedFiles.length, 5);
			return hiddenCount > 0
				? `Changed files (${changedFiles.length}): ${visibleFiles}, +${hiddenCount} more.`
				: `Changed files (${changedFiles.length}): ${visibleFiles}.`;
		}

		if (execution.file_changed === true) {
			return "Changed files were detected, but a scoped diff summary could not be derived.";
		}
	}

	return task.result?.trim()
		? "Diff summary unavailable; inspect the task result for details."
		: "Diff summary unavailable.";
}

function getVerificationSummary(task: TaskRecord): string {
	return (
		task.execution?.verification_summary?.trim() ||
		"Verification summary unavailable."
	);
}

function summarizeAuthoritativeContext(task: TaskRecord): string[] {
	const context = task.authoritative_context?.trim();
	if (!context) return [];

	const extracted =
		context.match(/<plan-context>\s*([\s\S]*?)\s*<\/plan-context>/i)?.[1] ??
		context;

	return extracted
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith("<") && !line.startsWith("</"))
		.slice(0, 8);
}

function buildFollowThroughBlockerSummary(
	task: TaskRecord,
): string | undefined {
	if (task.error?.trim()) return task.error.trim();

	const retry = task.assignment?.retry;
	if (retry?.last_resync_summary?.trim()) {
		return retry.last_resync_summary.trim();
	}

	return undefined;
}

async function ensureTerminalSummaries(
	state: TaskStateManager,
	task: TaskRecord,
): Promise<TaskRecord> {
	const execution = task.execution;
	if (!execution) return task;

	const diffSummary = await buildDiffSummary(task);
	const verificationSummary = getVerificationSummary(task);
	const nextExecution: TaskExecutionRecord = {
		...execution,
		diff_summary: diffSummary,
		verification_summary: verificationSummary,
	};
	if (!hasExecutionTelemetryChanged(task.execution, nextExecution)) {
		return task;
	}

	return state.updateTask(task.id, { execution: nextExecution });
}

async function updateRootFollowThrough(
	state: TaskStateManager,
	task: TaskRecord,
	input: {
		status: "pending" | "delivered" | "waived";
		reason?: string;
		source: string;
	},
): Promise<TaskRecord> {
	const current = await ensureTerminalSummaries(state, task);
	const execution = current.execution;
	if (!execution) return current;

	const nextExecution: TaskExecutionRecord = {
		...execution,
		root_follow_through: {
			status: input.status,
			updated_at: new Date().toISOString(),
			reason: input.reason,
			source: input.source,
		},
	};
	return state.updateTask(current.id, { execution: nextExecution });
}

function buildRootFollowThroughPrompt(task: TaskRecord): string {
	const diffSummary =
		task.execution?.diff_summary ?? "Diff summary unavailable.";
	const verificationSummary = getVerificationSummary(task);
	const authoritativeContext = summarizeAuthoritativeContext(task);
	const blockerSummary = buildFollowThroughBlockerSummary(task);
	const lines = [
		"<system-reminder>",
		"[delegation-follow-through]",
		"A background child task reached a terminal state and needs root follow-through.",
		`Task ID: ${task.id}`,
		`Reference: ref:${task.id}`,
		`Agent: ${task.agent}`,
		`Task: ${task.description}`,
		`Status: ${task.status}`,
		`Diff summary: ${diffSummary}`,
		`Verification summary: ${verificationSummary}`,
	];

	if (blockerSummary) {
		lines.push(`Unresolved blocker: ${blockerSummary}`);
	}

	if (authoritativeContext.length > 0) {
		lines.push("Authoritative context summary:");
		for (const line of authoritativeContext) {
			lines.push(`- ${line}`);
		}
	}

	lines.push(
		"Resume from the saved primary kind + overlays contract when present; do not re-interview already confirmed branches.",
		"Continue the active plan now. Use background_output(task_id=...) or task_graph_status only if more detail is needed.",
		"</system-reminder>",
	);

	return lines.join("\n");
}

async function handleRootFollowThrough(
	client: DelegationClient,
	state: TaskStateManager,
	workspaceDir: string,
	task: TaskRecord,
	logger: ReturnType<typeof createLogger>,
): Promise<TaskRecord> {
	if (!task.run_in_background || !shouldAttemptRootFollowThrough(task.status)) {
		return task;
	}

	const currentStatus = task.execution?.root_follow_through?.status;
	if (currentStatus === "delivered" || currentStatus === "waived") {
		return task;
	}

	const prepared = await updateRootFollowThrough(state, task, {
		status: "pending",
		reason: undefined,
		source: "terminal",
	});
	const continuationMode = await readContinuationMode(
		workspaceDir,
		prepared.root_session_id,
	);
	if (continuationMode !== "running") {
		return updateRootFollowThrough(state, prepared, {
			status: "pending",
			reason: `Root continuation is ${continuationMode}; follow-through remains unresolved until explicit cancel or handoff clears it.`,
			source: `continuation-${continuationMode}`,
		});
	}

	const response = await client.session.promptAsync({
		path: { id: prepared.root_session_id },
		body: {
			parts: [{ type: "text", text: buildRootFollowThroughPrompt(prepared) }],
		},
	});
	if (response.error) {
		logger.warn("Root follow-through prompt failed", {
			task_id: prepared.id,
			root_session_id: prepared.root_session_id,
			error: String(response.error),
		});
		return updateRootFollowThrough(state, prepared, {
			status: "pending",
			reason: `Auto-resume failed: ${String(response.error)}`,
			source: "prompt-failed",
		});
	}

	return updateRootFollowThrough(state, prepared, {
		status: "delivered",
		reason:
			"Root session auto-resume was dispatched after child terminalization.",
		source: "auto-resume",
	});
}

async function buildExecutionTelemetry(
	task: TaskRecord,
	primaryDirectory: string,
	transcriptData: unknown,
): Promise<TaskExecutionRecord | undefined> {
	const execution = task.execution;
	if (!execution) return undefined;

	const summary = summarizeSessionActivity(transcriptData);
	const fileChanged =
		execution.mode === "worktree" && execution.worktree_path
			? await hasUncommittedChanges(execution.worktree_path)
			: (execution.file_changed ?? false);

	return {
		...execution,
		effective_root_path:
			execution.worktree_path ??
			execution.effective_root_path ??
			primaryDirectory,
		read_count: summary.read_count,
		search_count: summary.search_count,
		planning_count: summary.planning_count,
		edit_count: summary.edit_count,
		other_count: summary.other_count,
		file_changed: fileChanged,
		edit_or_blocked_threshold: isTinyFrontendImplementationTask(task)
			? getTinyFrontendThreshold(task)
			: execution.edit_or_blocked_threshold,
		stale_reason:
			summary.edit_count > 0 || fileChanged
				? undefined
				: execution.stale_reason,
	};
}

async function persistExecutionTelemetry(
	state: TaskStateManager,
	task: TaskRecord,
	primaryDirectory: string,
	transcriptData: unknown,
): Promise<TaskRecord> {
	const nextExecution = await buildExecutionTelemetry(
		task,
		primaryDirectory,
		transcriptData,
	);
	if (!nextExecution) return task;
	if (!hasExecutionTelemetryChanged(task.execution, nextExecution)) {
		return task;
	}

	return state.updateTask(task.id, { execution: nextExecution });
}

function getNonEditReadPassCount(
	execution: TaskExecutionRecord | undefined,
): number {
	if (!execution) return 0;
	return (
		(execution.read_count ?? 0) +
		(execution.search_count ?? 0) +
		(execution.planning_count ?? 0)
	);
}

async function maybeBlockStaleTinyFrontendTask(
	state: TaskStateManager,
	task: TaskRecord,
	resultText?: string,
): Promise<TaskRecord | null> {
	if (task.status !== "running") return null;
	if (!isTinyFrontendImplementationTask(task)) return null;

	const execution = task.execution;
	if (!execution) return null;
	if ((execution.edit_count ?? 0) > 0 || execution.file_changed === true) {
		return null;
	}

	const threshold =
		execution.edit_or_blocked_threshold ??
		TINY_FRONTEND_EDIT_OR_BLOCKED_THRESHOLD;
	const nonEditCount = getNonEditReadPassCount(execution);
	if (nonEditCount < threshold) return null;

	const reason = `Tiny frontend implementation task exceeded the short read pass without an edit attempt (${nonEditCount}/${threshold} read/search/planning calls).`;
	const nextExecution: TaskExecutionRecord = {
		...execution,
		edit_or_blocked_threshold: threshold,
		stale_reason: reason,
	};
	await state.updateTask(task.id, { execution: nextExecution });
	return state.transitionTask(task.id, "blocked", {
		result: appendResultNote(
			resultText,
			`${reason} Blocked instead of widening scope; retry with clearer file or scope context.`,
		),
		error: reason,
	});
}

interface VerificationSelection {
	command?: string;
	strategy: "targeted" | "fallback" | "not_required";
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

	const [committedDiff, workingDiff, stagedDiff, untrackedDiff] =
		await Promise.all([
			runGitCommand(
				["diff", "--name-only", `${execution.base_branch}...HEAD`],
				execution.worktree_path,
			),
			runGitCommand(["diff", "--name-only"], execution.worktree_path),
			runGitCommand(
				["diff", "--cached", "--name-only"],
				execution.worktree_path,
			),
			runGitCommand(
				["ls-files", "--others", "--exclude-standard"],
				execution.worktree_path,
			),
		]);

	return [
		...new Set(
			[
				committedDiff.stdout,
				workingDiff.stdout,
				stagedDiff.stdout,
				untrackedDiff.stdout,
			]
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

	if (!execution || execution.mode !== "worktree") {
		return {
			command: defaultCommand,
			strategy: "fallback",
			candidateCommands: defaultCommand ? [defaultCommand] : [],
			fallbackCommand: defaultCommand,
			reason: "Task is not running in a worktree.",
		};
	}

	const changedFiles = await listChangedFilesAgainstBase(execution);
	if (changedFiles.length === 0) {
		return {
			command: undefined,
			strategy: "not_required",
			candidateCommands: [],
			fallbackCommand: defaultCommand,
			reason: "No worktree edits were produced.",
		};
	}

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

	if (!isManagerOwnedCAIDTask(task)) {
		return {
			command: defaultCommand,
			strategy: "fallback",
			candidateCommands: defaultCommand ? [defaultCommand] : [],
			fallbackCommand: defaultCommand,
			reason:
				"Changed files were detected, but this task is outside the manager-owned CAID workflow so fallback verification remains in use.",
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
	transcriptData?: unknown,
): Promise<TaskRecord> {
	const execution = transcriptData
		? await buildExecutionTelemetry(task, primaryDirectory, transcriptData)
		: task.execution;
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

	if (verificationSelection.strategy === "not_required") {
		const nextExecution: TaskExecutionRecord = {
			...execution,
			merge_status: "bypassed",
			verification_status: "not_required",
			verification_strategy: "not_required",
			verification_candidates: [],
			verification_command: undefined,
			verification_summary: verificationSelection.reason,
		};
		await state.updateTask(task.id, {
			execution: nextExecution,
			assignment: nextVerificationAssignment,
		});
		return state.transitionTask(task.id, "succeeded", {
			result: appendResultNote(
				resultText,
				"No worktree edits were produced; verification and merge were skipped.",
			),
		});
	}

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
			merge_status: "deferred",
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
		return state.transitionTask(task.id, "succeeded", {
			result: appendResultNote(
				resultText,
				"Verification passed, but merge was deferred because the repository root has uncommitted changes. Clean the root and continue the task to retry the merge.",
			),
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
	if (payload.execution.effective_root_path) {
		lines.push(`effective_root_path: ${payload.execution.effective_root_path}`);
	}
	if (payload.execution.verification_strategy) {
		lines.push(
			`verification_strategy: ${payload.execution.verification_strategy}`,
		);
	}
	if (payload.execution.diff_summary) {
		lines.push(`diff_summary: ${payload.execution.diff_summary}`);
	}
	lines.push(
		`verification_summary: ${payload.execution.verification_summary ?? "Verification summary unavailable."}`,
	);
	if (payload.execution.root_follow_through?.status) {
		lines.push(
			`root_follow_through: ${payload.execution.root_follow_through.status}`,
		);
		if (payload.execution.root_follow_through.reason) {
			lines.push(
				`root_follow_through_reason: ${payload.execution.root_follow_through.reason}`,
			);
		}
	}
	if (
		typeof payload.execution.read_count === "number" ||
		typeof payload.execution.search_count === "number" ||
		typeof payload.execution.planning_count === "number" ||
		typeof payload.execution.edit_count === "number"
	) {
		lines.push(
			`activity: read=${payload.execution.read_count ?? 0}, search=${payload.execution.search_count ?? 0}, planning=${payload.execution.planning_count ?? 0}, edit=${payload.execution.edit_count ?? 0}`,
		);
	}
	if (typeof payload.execution.file_changed === "boolean") {
		lines.push(
			`file_changed: ${payload.execution.file_changed ? "true" : "false"}`,
		);
	}
	if (typeof payload.execution.edit_or_blocked_threshold === "number") {
		lines.push(
			`edit_or_blocked_threshold: ${payload.execution.edit_or_blocked_threshold}`,
		);
	}
	if (payload.execution.stale_reason) {
		lines.push(`stale_reason: ${payload.execution.stale_reason}`);
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
	if (payload.execution.effective_root_path) {
		lines.push(`Root: ${payload.execution.effective_root_path}`);
	}
	if (payload.assignment?.workflow) {
		lines.push(`Workflow: ${payload.assignment.workflow}`);
	}
	if (payload.execution.verification_strategy) {
		lines.push(`Verification: ${payload.execution.verification_strategy}`);
	}
	if (payload.execution.diff_summary) {
		lines.push(`Diff: ${payload.execution.diff_summary}`);
	}
	lines.push(
		`Verification summary: ${payload.execution.verification_summary ?? "Verification summary unavailable."}`,
	);
	if (payload.assignment?.retry?.state) {
		lines.push(
			`Retry: ${payload.assignment.retry.state}${payload.assignment.retry.reason ? ` (${payload.assignment.retry.reason})` : ""}`,
		);
	}
	if (payload.assignment?.review?.status) {
		lines.push(`Review: ${payload.assignment.review.status}`);
	}
	if (payload.execution.root_follow_through?.status) {
		lines.push(
			`Root follow-through: ${payload.execution.root_follow_through.status}`,
		);
		if (payload.execution.root_follow_through.reason) {
			lines.push(
				`Root follow-through reason: ${payload.execution.root_follow_through.reason}`,
			);
		}
	}
	if (
		typeof payload.execution.read_count === "number" ||
		typeof payload.execution.search_count === "number" ||
		typeof payload.execution.planning_count === "number" ||
		typeof payload.execution.edit_count === "number"
	) {
		lines.push(
			`Activity: read=${payload.execution.read_count ?? 0}, search=${payload.execution.search_count ?? 0}, planning=${payload.execution.planning_count ?? 0}, edit=${payload.execution.edit_count ?? 0}`,
		);
	}
	if (typeof payload.execution.file_changed === "boolean") {
		lines.push(
			`Files changed: ${payload.execution.file_changed ? "yes" : "no"}`,
		);
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
			parts: [{ type: "text", text: buildChildPrompt(task) }],
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
	workspaceDir: string,
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
			const failed = await state.transitionTask(task.id, "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			await handleRootFollowThrough(
				client,
				state,
				workspaceDir,
				failed,
				logger,
			);
		}
	}
	return;
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
	options?: {
		fallbackStatus?: "idle" | "running" | "error";
	},
): Promise<TaskRecord> {
	if (task.status !== "running") return task;

	const runtimeStatus =
		(await getSessionStatus(client, task.child_session_id)) ??
		options?.fallbackStatus;
	if (runtimeStatus === "error") {
		return state.transitionTask(task.id, "failed", {
			error: "Task session reported an error.",
		});
	}

	const transcriptData = await getSessionTranscriptData(
		client,
		task.child_session_id,
	);
	const current = await persistExecutionTelemetry(
		state,
		task,
		primaryDirectory,
		transcriptData,
	);

	if (runtimeStatus === "idle") {
		const staleBlocked = await maybeBlockStaleTinyFrontendTask(
			state,
			current,
			extractLatestAssistantText(transcriptData) ?? undefined,
		);
		if (staleBlocked) {
			return staleBlocked;
		}
	}

	if (runtimeStatus === "idle") {
		const result = extractLatestAssistantText(transcriptData);
		return integrateWorktreeTask(
			primaryDirectory,
			state,
			current,
			result ?? undefined,
			logger,
			transcriptData,
		);
	}

	return current;
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
			.then(() => promoteRunnableTasks(client, state, workspaceDir, logger));
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
				const refreshed = await refreshTaskFromRuntime(
					client,
					state,
					ctx.directory,
					task,
					logger,
					{ fallbackStatus: "idle" },
				);
				if (refreshed.status === "running") {
					return;
				}

				await handleRootFollowThrough(
					client,
					state,
					workspaceDir,
					refreshed,
					logger,
				);
				await queuePromotionPass();
				return;
			}

			if (runtimeEvent.type === "session.error") {
				const terminal = await state.transitionTask(task.id, "failed", {
					error: getEventError(runtimeEvent),
				});
				await handleRootFollowThrough(
					client,
					state,
					workspaceDir,
					terminal,
					logger,
				);
				await queuePromotionPass();
				return;
			}

			const terminal = await state.transitionTask(task.id, "cancelled", {
				error:
					runtimeEvent.type === "session.interrupt"
						? "Task session interrupted."
						: "Task session deleted.",
			});
			await handleRootFollowThrough(
				client,
				state,
				workspaceDir,
				terminal,
				logger,
			);
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
					authoritative_context: tool.schema
						.string()
						.optional()
						.describe(
							"Optional authoritative parent context / working set to prepend for the child task.",
						),
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
					logger.debug("Normalizing task authoritative context", {
						description,
						...getAuthoritativeContextExtractionTelemetry({
							prompt: args.prompt,
							authoritativeContext: args.authoritative_context,
						}),
					});
					const normalizedTaskInput = extractInlineAuthoritativeContext({
						prompt: args.prompt,
						authoritativeContext: args.authoritative_context,
					});
					const prompt = normalizedTaskInput.prompt;
					const authoritativeContext = normalizedTaskInput.authoritativeContext;
					logger.debug("Resolved task authoritative context", {
						description,
						has_authoritative_context: Boolean(authoritativeContext),
						prompt_preview: prompt.slice(0, 120),
						authoritative_context_preview: authoritativeContext?.slice(0, 120),
					});
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

							let preparedExecution: TaskExecutionRecord;
							try {
								preparedExecution = await prepareTaskExecution(
									ctx.directory,
									{
										taskID: existing.id,
										agent,
										category,
										description,
										prompt,
										command: args.command?.trim(),
										existing: existing.execution,
									},
									logger,
								);
							} catch (error) {
								return `❌ ${error instanceof Error ? error.message : String(error)}`;
							}
							const execution = withInitialRootFollowThrough(
								preparedExecution,
								runInBackground,
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
								authoritative_context: authoritativeContext,
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
						let preparedExecution: TaskExecutionRecord;
						try {
							preparedExecution = await prepareTaskExecution(
								ctx.directory,
								{
									taskID,
									agent,
									category,
									description,
									prompt,
									command: args.command?.trim(),
								},
								logger,
							);
						} catch (error) {
							return `❌ ${error instanceof Error ? error.message : String(error)}`;
						}
						const execution = withInitialRootFollowThrough(
							preparedExecution,
							runInBackground,
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
							authoritative_context: authoritativeContext,
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
								parts: [{ type: "text", text: buildChildPrompt(task) }],
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

						const transcriptData = await getSessionTranscriptData(
							client,
							task.child_session_id,
						);
						const resultText =
							extractPromptResponseText(response.data) ??
							extractLatestAssistantText(transcriptData) ??
							"";
						const succeeded = await integrateWorktreeTask(
							ctx.directory,
							state,
							task,
							resultText || undefined,
							logger,
							transcriptData,
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

					if (
						toolCtx.sessionID === current.root_session_id &&
						isTerminalTask(current.status) &&
						current.execution?.root_follow_through?.status === "pending"
					) {
						current = await updateRootFollowThrough(state, current, {
							status: "delivered",
							reason:
								"Root session consumed the terminal child output via background_output.",
							source: "background-output",
						});
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
							const currentCancelled = await state.transitionTask(
								task.id,
								"cancelled",
								{
									error: reasonText
										? `Cancelled: ${reasonText}`
										: "Task cancelled by user request.",
								},
							);
							cancelled.push(
								await updateRootFollowThrough(state, currentCancelled, {
									status: "waived",
									reason: reasonText
										? `Cancelled: ${reasonText}`
										: "Task cancelled by user request.",
									source: "background-cancel",
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
						const waived = await updateRootFollowThrough(state, task, {
							status: "waived",
							reason: reasonText
								? `Cancelled: ${reasonText}`
								: "Task cancelled by user request.",
							source: "background-cancel",
						});
						await emitTaskMetadata(toolCtx, toolMetadata, waived);
						return formatTaskStatus(waived);
					}

					if (task.status === "running") {
						await client.session
							.abort({
								path: { id: task.child_session_id },
							})
							.catch(() => undefined);
					}

					const terminal = await state.transitionTask(task.id, "cancelled", {
						error: reasonText
							? `Cancelled: ${reasonText}`
							: "Task cancelled by user request.",
					});
					const cancelled = await updateRootFollowThrough(state, terminal, {
						status: "waived",
						reason: reasonText
							? `Cancelled: ${reasonText}`
							: "Task cancelled by user request.",
						source: "background-cancel",
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
export { buildTaskGraph } from "./task-graph.js";
