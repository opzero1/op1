/**
 * Workspace Plugin
 *
 * Plan management, notepads, verification hooks.
 * Uses Bun-native APIs exclusively (no node: imports).
 *
 * This is the orchestrator — all logic lives in submodules:
 *   hooks/   — safe-hook, tool-output-safety, verification, shell-env, compaction
 *   plan/    — schema, status, state
 *   utils.ts — shared helpers
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { homedir, join, mkdir, relative, resolve } from "./bun-compat.js";
import { createContextScoutStateManager } from "./context-scout/state.js";
import { createContinuationStateManager } from "./continuation/state.js";
import {
	type DoctorReport,
	formatDoctorReport,
	redactDoctorReport,
	runDoctorDiagnostics,
} from "./doctor.js";
import { executeHashAnchoredEdit } from "./hash-anchor/edit.js";
import { createAutonomyPolicyHook } from "./hooks/autonomy-policy.js";
import {
	type CompactionDeps,
	createCompactionHook,
} from "./hooks/compaction.js";
import { createCompletionPromiseHook } from "./hooks/completion-promise.js";
import { createContextScoutHook } from "./hooks/context-scout.js";
import {
	createEditSafetyAfterHook,
	createEditSafetyBeforeHook,
} from "./hooks/edit-safety.js";
import { createHashAnchorReadEnhancerHook } from "./hooks/hash-anchor-read-enhancer.js";
import { createMomentumHook, type MomentumDeps } from "./hooks/momentum.js";
import { createToolExecuteBeforeHook } from "./hooks/non-interactive-guard.js";
import {
	createNotificationChannelsHook,
	type NotificationClient,
} from "./hooks/notification-channels.js";
import {
	type CompactionClient,
	checkPreemptiveCompaction,
	markCompactionStateDirty,
} from "./hooks/preemptive-compaction.js";
import { createRulesInjectorLiteHook } from "./hooks/rules-injector-lite.js";
// ── Modules ────────────────────────────────────────────────
import {
	createSafeRuntimeHook,
	loadHookConfig,
	type ResolvedHookConfig,
} from "./hooks/safe-hook.js";
import { createShellEnvHook } from "./hooks/shell-env.js";
import { createTaskReminderHook } from "./hooks/task-reminder.js";
import { handleToolOutputSafetyDynamic } from "./hooks/tool-output-safety.js";
import { handleVerification } from "./hooks/verification.js";
import { createWritePolicyHook } from "./hooks/write-policy.js";
import { buildMcpOAuthHelperSnapshot } from "./interop/mcp-oauth-helper.js";
import { buildMcp0HealthSnapshot } from "./interop/mcp0-health.js";

import { formatParseError, parsePlanMarkdown } from "./plan/schema.js";
import {
	type ActivePlanState,
	type ConfirmedPatternExample,
	createStateManager,
	generatePlanMetadata,
	generatePlanPath,
	getPlanName,
	type LinkPlanDocInput,
	NOTEPAD_FILES,
	type NotepadFile,
	type PlanContextPatch,
	type PlanDocType,
	type PlanQuestionAnswer,
} from "./plan/state.js";
import { autoUpdatePlanStatus, calculatePlanStatus } from "./plan/status.js";
import {
	executeSessionInfo,
	executeSessionList,
	executeSessionRead,
	executeSessionSearch,
} from "./session-history.js";
import { getProjectId, isSystemError } from "./utils.js";
import { createWorktreeTools } from "./worktree/index.js";

// ── Plugin ─────────────────────────────────────────────────

export const WorkspacePlugin: Plugin = async (ctx) => {
	const { directory } = ctx;

	const projectId = await getProjectId(directory);

	// Legacy session-scoped directory (for migration fallback)
	const legacyBaseDir = join(
		homedir(),
		".local",
		"share",
		"opencode",
		"workspace",
		projectId,
	);

	// New project-scoped directories
	const workspaceDir = join(directory, ".opencode", "workspace");
	const plansDir = join(workspaceDir, "plans");
	const notepadsDir = join(workspaceDir, "notepads");
	const activePlanPath = join(workspaceDir, "active-plan.json");

	// State manager delegates all plan/notepad CRUD
	const sm = createStateManager(
		workspaceDir,
		plansDir,
		notepadsDir,
		activePlanPath,
	);
	const contextScoutState = createContextScoutStateManager(workspaceDir);
	const continuationState = createContinuationStateManager(workspaceDir);

	// Hook configuration (global + project config + env overrides)
	const hookConfig: ResolvedHookConfig = await loadHookConfig(directory);

	// ── Session helpers ────────────────────────────────────

	async function getRootSessionID(sessionID?: string): Promise<string> {
		if (!sessionID) {
			throw new Error("sessionID is required to resolve root session scope");
		}

		let currentID = sessionID;
		for (let depth = 0; depth < 10; depth++) {
			const session = await ctx.client.session.get({
				path: { id: currentID },
			});

			if (!session.data?.parentID) {
				return currentID;
			}

			currentID = session.data.parentID;
		}

		throw new Error(
			"Failed to resolve root session: maximum traversal depth exceeded",
		);
	}

	function parsePlanFrontmatter(content: string): {
		status?: string;
		phase?: string;
	} {
		const statusMatch = content.match(/^status:\s*([^\n]+)/m);
		const phaseMatch = content.match(/^phase:\s*([^\n]+)/m);

		return {
			status: statusMatch?.[1]?.trim(),
			phase: phaseMatch?.[1]?.trim(),
		};
	}

	async function getActivePlanPhase(): Promise<string | null> {
		const activePlan = await sm.readActivePlanState();
		if (!activePlan) return null;

		try {
			const file = Bun.file(activePlan.active_plan);
			if (!(await file.exists())) return null;
			const content = await file.text();
			return parsePlanFrontmatter(content).phase ?? null;
		} catch {
			return null;
		}
	}

	function readSectionByHeading(
		content: string,
		heading: string,
	): string | null {
		const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(
			`^(#{1,6}\\s+${escapedHeading}\\s*)$([\\s\\S]*?)(?=^#{1,6}\\s+|$)`,
			"im",
		);
		const match = content.match(regex);
		if (!match) return null;
		return `${match[1]}${match[2]}`.trim();
	}

	function toAbsoluteDocPath(pathValue: string): string {
		if (pathValue.startsWith("~")) {
			return resolve(homedir(), pathValue.slice(1));
		}

		if (pathValue.startsWith("/")) {
			return resolve(pathValue);
		}

		return resolve(directory, pathValue);
	}

	function parseJsonArrayArg<T>(args: {
		value?: string;
		label: string;
		mapper: (item: unknown) => T | null;
	}): T[] {
		if (!args.value) return [];

		let parsed: unknown;
		try {
			parsed = JSON.parse(args.value);
		} catch (error) {
			throw new Error(
				`${args.label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (!Array.isArray(parsed)) {
			throw new Error(`${args.label} must be a JSON array.`);
		}

		return parsed
			.map((item) => args.mapper(item))
			.filter((item): item is T => item !== null);
	}

	function parsePlanQuestionAnswerInput(
		value: unknown,
	): PlanQuestionAnswer | null {
		if (!value || typeof value !== "object") return null;

		const raw = value as Record<string, unknown>;
		if (typeof raw.question !== "string" || raw.question.trim().length === 0) {
			return null;
		}

		return {
			id:
				typeof raw.id === "string" && raw.id.trim().length > 0
					? raw.id.trim()
					: `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			question: raw.question.trim(),
			header:
				typeof raw.header === "string" && raw.header.trim().length > 0
					? raw.header.trim()
					: undefined,
			answers: Array.isArray(raw.answers)
				? raw.answers
						.filter((item): item is string => typeof item === "string")
						.map((item) => item.trim())
						.filter((item) => item.length > 0)
				: [],
			source: raw.source === "question-tool" ? "question-tool" : "freeform",
			phase:
				typeof raw.phase === "string" && raw.phase.trim().length > 0
					? raw.phase.trim()
					: undefined,
			task:
				typeof raw.task === "string" && raw.task.trim().length > 0
					? raw.task.trim()
					: undefined,
			confirmed_by_user: raw.confirmed_by_user !== false,
			captured_at:
				typeof raw.captured_at === "string" && raw.captured_at.trim().length > 0
					? raw.captured_at.trim()
					: new Date().toISOString(),
		};
	}

	function parsePatternExampleInput(
		value: unknown,
	): ConfirmedPatternExample | null {
		if (!value || typeof value !== "object") return null;

		const raw = value as Record<string, unknown>;
		if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
			return null;
		}
		if (
			typeof raw.why_it_fits !== "string" ||
			raw.why_it_fits.trim().length === 0
		) {
			return null;
		}

		const parseList = (input: unknown): string[] =>
			Array.isArray(input)
				? input
						.filter((item): item is string => typeof item === "string")
						.map((item) => item.trim())
						.filter((item) => item.length > 0)
				: [];

		return {
			name: raw.name.trim(),
			example_files: parseList(raw.example_files),
			symbols: parseList(raw.symbols),
			why_it_fits: raw.why_it_fits.trim(),
			constraints: parseList(raw.constraints),
			blast_radius: parseList(raw.blast_radius),
			test_implications: parseList(raw.test_implications),
			confirmed_by_user: raw.confirmed_by_user !== false,
		};
	}

	function formatPlanContextBlock(
		context: PlanContextPatch & { plan_name?: string },
	): string {
		const sections = [
			"<plan-context>",
			`stage: ${context.stage ?? "draft"}`,
			`confirmed_by_user: ${context.confirmed_by_user === true ? "true" : "false"}`,
		];

		if (context.plan_name) {
			sections.push(`plan_name: ${context.plan_name}`);
		}
		if (context.goal) {
			sections.push("", "Goal:", `- ${context.goal}`);
		}
		if (context.chosen_pattern) {
			sections.push("", "Chosen pattern:", `- ${context.chosen_pattern}`);
		}

		const pushList = (label: string, values?: string[]) => {
			if (!values || values.length === 0) return;
			sections.push("", `${label}:`, ...values.map((item) => `- ${item}`));
		};

		pushList("Affected areas", context.affected_areas);
		pushList("Blast radius", context.blast_radius);
		pushList("Success criteria", context.success_criteria);
		pushList("Failure criteria", context.failure_criteria);
		pushList("Test plan", context.test_plan);
		pushList("Open risks", context.open_risks);

		if (context.oracle_summary) {
			sections.push("", "Oracle summary:", `- ${context.oracle_summary}`);
		}

		const patternExamples = context.pattern_examples ?? [];
		if (patternExamples.length > 0) {
			sections.push("", "Confirmed pattern examples:");
			for (const pattern of patternExamples) {
				sections.push(`- ${pattern.name}: ${pattern.why_it_fits}`);
				if (pattern.example_files.length > 0) {
					sections.push(`  files: ${pattern.example_files.join(", ")}`);
				}
				if (pattern.symbols.length > 0) {
					sections.push(`  symbols: ${pattern.symbols.join(", ")}`);
				}
			}
		}

		const questionAnswers = context.question_answers ?? [];
		if (questionAnswers.length > 0) {
			sections.push("", "Captured confirmations:");
			for (const item of questionAnswers) {
				const answers =
					item.answers.length > 0
						? item.answers.join(", ")
						: "(no answer recorded)";
				sections.push(`- ${item.header ?? item.question}: ${answers}`);
			}
		}

		sections.push("</plan-context>");
		return sections.join("\n");
	}

	// ── Hook factories ─────────────────────────────────────

	const nonInteractiveBeforeHook = createSafeRuntimeHook(
		"tool.execute.before.nonInteractiveGuard",
		() => createToolExecuteBeforeHook(),
		hookConfig,
	);

	const editSafetyBeforeHook = createSafeRuntimeHook(
		"tool.execute.before.editSafetyGuard",
		() => createEditSafetyBeforeHook(directory),
		hookConfig,
	);

	const toolExecuteBeforeHook =
		nonInteractiveBeforeHook || editSafetyBeforeHook
			? async (
					input: { tool: string; sessionID: string; callID: string },
					output: { args: Record<string, unknown> },
				) => {
					if (nonInteractiveBeforeHook) {
						await nonInteractiveBeforeHook(input, output);
					}

					if (editSafetyBeforeHook) {
						await editSafetyBeforeHook(input, output);
					}
				}
			: null;

	// Phase 3 hook factories (created once, reused in tool.execute.after)
	const momentumDeps: MomentumDeps = {
		readActivePlanState: sm.readActivePlanState,
		shouldContinue: (sessionID: string) =>
			continuationState.isContinuationAllowed(sessionID),
	};
	const momentumHandler = createSafeRuntimeHook(
		"momentum",
		() => createMomentumHook(momentumDeps),
		hookConfig,
	);
	const completionPromiseHandler = createSafeRuntimeHook(
		"completionPromise",
		() => createCompletionPromiseHook(),
		hookConfig,
	);
	const writePolicyHandler = createSafeRuntimeHook(
		"writePolicy",
		() => createWritePolicyHook(),
		hookConfig,
	);
	const taskReminderHandler = createSafeRuntimeHook(
		"taskReminder",
		() => createTaskReminderHook(hookConfig.thresholds.taskReminderThreshold),
		hookConfig,
	);
	const autonomyPolicyHandler = createSafeRuntimeHook(
		"autonomyPolicy",
		() => createAutonomyPolicyHook(),
		hookConfig,
	);
	const editSafetyAfterHook = createSafeRuntimeHook(
		"tool.execute.after.editSafetyGuard",
		() => createEditSafetyAfterHook(directory),
		hookConfig,
	);
	const rulesInjectorLiteHook = createSafeRuntimeHook(
		"tool.execute.after.rulesInjectorLite",
		() => createRulesInjectorLiteHook({ getCurrentPhase: getActivePlanPhase }),
		hookConfig,
	);
	const notificationChannelsHook = createSafeRuntimeHook(
		"tool.execute.after.notificationChannels",
		() =>
			createNotificationChannelsHook(
				ctx.client as unknown as NotificationClient,
				{
					enabled: hookConfig.notifications.enabled,
					desktop: hookConfig.notifications.desktop,
					quietHours: hookConfig.notifications.quietHours,
					timezone: hookConfig.notifications.timezone,
					privacy: hookConfig.notifications.privacy,
				},
			),
		hookConfig,
	);
	const hashAnchorReadEnhancerHook = createSafeRuntimeHook(
		"tool.execute.after.hashAnchorReadEnhancer",
		() =>
			createHashAnchorReadEnhancerHook({
				enabled: hookConfig.features.hashAnchoredEdit,
			}),
		hookConfig,
	);
	const contextScoutAfterHook = createSafeRuntimeHook(
		"tool.execute.after.contextScout",
		() =>
			createContextScoutHook({
				enabled: hookConfig.features.contextScout,
				stateManager: contextScoutState,
				workspaceRoot: directory,
			}),
		hookConfig,
	);

	const toolExecuteAfterHook = createSafeRuntimeHook(
		"tool.execute.after",
		() =>
			async (
				input: {
					tool: string;
					sessionID: string;
					callID: string;
					args?: unknown;
				},
				output: { title: string; output: string; metadata: unknown },
			) => {
				const toolName = input.tool.toLowerCase();

				if (
					toolName === "plan_save" ||
					toolName === "plan_set_active" ||
					toolName === "plan_archive" ||
					toolName === "plan_unarchive" ||
					toolName === "notepad_write" ||
					toolName === "todowrite" ||
					toolName === "plan_doc_link"
				) {
					markCompactionStateDirty(input.sessionID);
				}

				// Dynamic context-window-aware truncation (falls back to static)
				await handleToolOutputSafetyDynamic(input, output, ctx.client);

				// Edit/read safety tracking and violation telemetry
				if (editSafetyAfterHook) await editSafetyAfterHook(input, output);

				// Optional LINE#ID read-output enhancement
				if (hashAnchorReadEnhancerHook)
					await hashAnchorReadEnhancerHook(input, output);

				// ContextScout extraction + ranked, budgeted injection
				if (contextScoutAfterHook) await contextScoutAfterHook(input, output);

				// Phase-scoped idempotent rules injection
				if (rulesInjectorLiteHook) await rulesInjectorLiteHook(input, output);

				// Optional, deduplicated notification-channel events
				if (notificationChannelsHook)
					await notificationChannelsHook(input, output);

				// Async: verification reminders after implementer agent tasks
				await handleVerification(input, output, directory, {
					enabled: hookConfig.verification.autopilot,
					throttleMs: hookConfig.verification.throttleMs,
				});

				// Preemptive compaction at 78% token usage
				await checkPreemptiveCompaction(
					ctx.client as unknown as CompactionClient,
					input.sessionID,
					directory,
					{
						contextLimit: hookConfig.thresholds.contextLimit,
						thresholdRatio: hookConfig.thresholds.compactionThreshold,
					},
				);

				// Phase 3: Continuation & enforcement hooks
				if (momentumHandler) await momentumHandler(input, output);
				if (completionPromiseHandler)
					await completionPromiseHandler(input, output);
				if (writePolicyHandler) await writePolicyHandler(input, output);
				if (taskReminderHandler) await taskReminderHandler(input, output);
				if (autonomyPolicyHandler) await autonomyPolicyHandler(input, output);
			},
		hookConfig,
	);

	const shellEnvHook = createSafeRuntimeHook(
		"shell.env",
		() => createShellEnvHook(),
		hookConfig,
	);

	const compactionDeps: CompactionDeps = {
		readActivePlanState: sm.readActivePlanState,
		getNotepadDir: sm.getNotepadDir,
		readNotepadFile: sm.readNotepadFile,
		getPlanDocLinks: sm.getPlanDocLinks,
	};

	const compactionHook = createSafeRuntimeHook(
		"experimental.session.compacting",
		() => createCompactionHook(compactionDeps),
		hookConfig,
	);

	// ── Worktree tools ─────────────────────────────────────
	const worktreeTools = createWorktreeTools(directory, projectId, {
		tmuxOrchestration: hookConfig.features.tmuxOrchestration,
		onTerminalSpawn: async (input) => {
			if (input.terminal !== "tmux") return;
			await continuationState.setSessionTmuxMetadata({
				session_id: input.sessionID,
				tmux_session_name: input.tmuxSessionName,
				tmux_window_name: input.tmuxWindowName,
			});
			markCompactionStateDirty(input.sessionID);
		},
	});

	// ── Build hook map (only include non-null hooks) ───────

	const hook: Record<string, unknown> = {};
	if (toolExecuteBeforeHook)
		hook["tool.execute.before"] = toolExecuteBeforeHook;
	if (toolExecuteAfterHook) hook["tool.execute.after"] = toolExecuteAfterHook;
	if (shellEnvHook) hook["shell.env"] = shellEnvHook;
	if (compactionHook) hook["experimental.session.compacting"] = compactionHook;
	const eventHook = async (payload: { event?: unknown }) => {
		void payload;
	};

	// ── Return plugin ──────────────────────────────────────

	return {
		tool: {
			doctor: tool({
				description:
					"Doctor diagnostics engine for workspace health checks with PII-safe output.",
				args: {
					include_details: tool.schema
						.boolean()
						.optional()
						.describe(
							"Include detailed check metadata in output (default: true).",
						),
				},
				async execute(args, toolCtx) {
					const report = await runDoctorDiagnostics({
						directory,
						workspaceDir,
						plansDir,
						notepadsDir,
						readActivePlanState: () =>
							sm.readActivePlanState(toolCtx?.sessionID),
						listPlanRecords: sm.listPlanRecords,
						readPlanDocRegistry: sm.readPlanDocRegistry,
					});

					const redacted = redactDoctorReport(report);
					const includeDetails = args.include_details ?? true;

					const finalReport: DoctorReport = includeDetails
						? redacted
						: {
								generated_at: redacted.generated_at,
								status: redacted.status,
								checks: redacted.checks.map((check) => ({
									id: check.id,
									status: check.status,
									summary: check.summary,
									remedy: check.remedy,
								})),
							};

					return formatDoctorReport(finalReport);
				},
			}),

			hash_anchored_edit: tool({
				description:
					"Apply strict hash-anchored file edits with deterministic preflight validation.",
				args: {
					filePath: tool.schema
						.string()
						.describe(
							"Target file path (absolute or relative to workspace root).",
						),
					anchors: tool.schema
						.string()
						.describe(
							"Line anchors to replace. Provide one anchor per line or comma-separated values (example: '12#abcd1234\\n13#efab5678').",
						),
					replacement: tool.schema
						.string()
						.describe("Replacement content for the anchored line range."),
				},
				async execute(args) {
					const anchors = args.anchors
						.split(/[,\n]/)
						.map((value) => value.trim())
						.filter((value) => value.length > 0);

					const result = await executeHashAnchoredEdit(
						{
							filePath: args.filePath,
							anchors,
							replacement: args.replacement,
						},
						{
							directory,
							enabled: hookConfig.features.hashAnchoredEdit,
						},
					);

					return JSON.stringify(result, null, 2);
				},
			}),

			session_list: tool({
				description:
					"List session history in current project scope with pagination and optional filtering.",
				args: {
					limit: tool.schema
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.describe("Maximum sessions to return (default: 20)."),
					roots: tool.schema
						.boolean()
						.optional()
						.describe("Only include root sessions (no parentID)."),
					start: tool.schema
						.number()
						.optional()
						.describe(
							"Only include sessions updated on/after epoch milliseconds.",
						),
					query: tool.schema
						.string()
						.optional()
						.describe("Search text (title-first filter, minimum 2 chars)."),
					search: tool.schema.string().optional().describe("Alias for query."),
					directory: tool.schema
						.string()
						.optional()
						.describe(
							"Optional explicit project directory scope (defaults to current project).",
						),
					include_details: tool.schema
						.boolean()
						.optional()
						.describe("Include additional per-session metadata in output."),
				},
				async execute(args) {
					try {
						return await executeSessionList(args, {
							client: ctx.client,
							projectDirectory: directory,
						});
					} catch (error) {
						if (error instanceof Error) return `❌ ${error.message}`;
						throw error;
					}
				},
			}),

			session_read: tool({
				description:
					"Read one session metadata record with optional recent message preview.",
				args: {
					session_id: tool.schema.string().describe("Session ID to inspect."),
					include_messages: tool.schema
						.boolean()
						.optional()
						.describe("Include recent message preview snippets."),
					message_limit: tool.schema
						.number()
						.int()
						.min(1)
						.max(30)
						.optional()
						.describe("Number of recent messages to preview (default: 8)."),
					directory: tool.schema
						.string()
						.optional()
						.describe(
							"Optional explicit project directory scope (defaults to current project).",
						),
					include_details: tool.schema
						.boolean()
						.optional()
						.describe("Include extra metadata fields for the session."),
				},
				async execute(args) {
					try {
						return await executeSessionRead(args, {
							client: ctx.client,
							projectDirectory: directory,
						});
					} catch (error) {
						if (error instanceof Error) return `❌ ${error.message}`;
						throw error;
					}
				},
			}),

			session_search: tool({
				description:
					"Search sessions by title/content using API search with local fallback filtering.",
				args: {
					query: tool.schema
						.string()
						.describe("Search term (minimum 2 characters)."),
					limit: tool.schema
						.number()
						.int()
						.min(1)
						.max(50)
						.optional()
						.describe("Maximum matched sessions to return (default: 10)."),
					roots: tool.schema
						.boolean()
						.optional()
						.describe("Only include root sessions (no parentID)."),
					start: tool.schema
						.number()
						.optional()
						.describe(
							"Only include sessions updated on/after epoch milliseconds.",
						),
					case_sensitive: tool.schema
						.boolean()
						.optional()
						.describe("Use case-sensitive matching for fallback filtering."),
					directory: tool.schema
						.string()
						.optional()
						.describe(
							"Optional explicit project directory scope (defaults to current project).",
						),
					include_details: tool.schema
						.boolean()
						.optional()
						.describe("Include additional metadata for matched sessions."),
				},
				async execute(args) {
					try {
						return await executeSessionSearch(args, {
							client: ctx.client,
							projectDirectory: directory,
						});
					} catch (error) {
						if (error instanceof Error) return `❌ ${error.message}`;
						throw error;
					}
				},
			}),

			session_info: tool({
				description:
					"Show session integrity and metadata snapshot including todos, children, and status view.",
				args: {
					session_id: tool.schema.string().describe("Session ID to inspect."),
					directory: tool.schema
						.string()
						.optional()
						.describe(
							"Optional explicit project directory scope (defaults to current project).",
						),
					include_details: tool.schema
						.boolean()
						.optional()
						.describe("Include status snapshot payload when available."),
				},
				async execute(args) {
					try {
						return await executeSessionInfo(args, {
							client: ctx.client,
							projectDirectory: directory,
						});
					} catch (error) {
						if (error instanceof Error) return `❌ ${error.message}`;
						throw error;
					}
				},
			}),

			plan_save: tool({
				description:
					"Save the implementation plan as markdown. Must include citations (ref:task-id) for decisions based on research. Supports draft saves before final promotion.",
				args: {
					content: tool.schema
						.string()
						.describe("The full plan in markdown format"),
					mode: tool.schema
						.enum(["active", "new", "draft"])
						.optional()
						.describe(
							"'active' updates the current active plan. 'new' creates a plan file. 'draft' creates a non-active draft plan for review and promotion.",
						),
					set_active: tool.schema
						.boolean()
						.optional()
						.describe(
							"When mode='new', set this new plan as active (default: true). Ignored for draft mode.",
						),
					identifier: tool.schema
						.string()
						.optional()
						.describe(
							"Optional existing plan name or path suffix to update, mainly for draft refinement saves.",
						),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_save requires sessionID. This is a system error.";
					}

					// Auto-calculate status from task checkboxes before validation
					const autoUpdatedContent = autoUpdatePlanStatus(args.content);

					const result = parsePlanMarkdown(autoUpdatedContent);
					if (!result.ok) {
						return formatParseError(result.error, result.hint);
					}

					const existingState = await sm.readActivePlanState(toolCtx.sessionID);
					const mode = args.mode ?? "active";
					const shouldSetActive =
						mode === "new" ? (args.set_active ?? true) : false;

					let planPath: string;
					let isNewPlan = false;
					let isDraftPlan = false;
					let metadata: { title: string; description: string } | undefined;

					if (mode === "active" && existingState) {
						planPath = existingState.active_plan;

						if (!existingState.session_ids.includes(toolCtx.sessionID)) {
							existingState.session_ids.push(toolCtx.sessionID);
							await sm.writeActivePlanState(existingState);
						}
					} else if (mode === "draft") {
						isDraftPlan = true;

						const records = await sm.listPlanRecords();
						const resolvedDraftPath = args.identifier
							? await sm.resolvePlanPath(args.identifier)
							: undefined;
						if (args.identifier && !resolvedDraftPath) {
							return `❌ Draft plan not found for identifier \"${args.identifier}\".`;
						}
						if (args.identifier && resolvedDraftPath) {
							const record = records.find(
								(item) => item.path === resolvedDraftPath,
							);
							if (record?.lifecycle !== "draft") {
								return `❌ ${args.identifier} is not a draft plan. Use mode='active' to update the active plan or provide a draft identifier.`;
							}
						}
						const latestDraftPath = records.find(
							(record) => record.lifecycle === "draft",
						)?.path;
						planPath = resolvedDraftPath ?? latestDraftPath ?? generatePlanPath(plansDir);

						if (!(resolvedDraftPath ?? latestDraftPath)) {
							await mkdir(plansDir, { recursive: true });
							isNewPlan = true;
						}

						metadata = await generatePlanMetadata(
							ctx.client,
							args.content,
							toolCtx.sessionID,
						);
					} else {
						await mkdir(plansDir, { recursive: true });
						planPath = generatePlanPath(plansDir);
						isNewPlan = true;

						metadata = await generatePlanMetadata(
							ctx.client,
							args.content,
							toolCtx.sessionID,
						);
					}

					await Bun.write(planPath, autoUpdatedContent);

					if (mode === "draft") {
						await sm.upsertPlanRegistryEntry(planPath, {
							title: metadata?.title,
							description: metadata?.description,
							lifecycle: "draft",
						});
						await sm.syncPlanContext(getPlanName(planPath), {
							stage: "draft",
							confirmed_by_user: false,
						});
					} else if (isNewPlan && (shouldSetActive || !existingState)) {
						await sm.setActivePlan(planPath, {
							sessionID: toolCtx.sessionID,
							title: metadata?.title,
							description: metadata?.description,
						});
					} else {
						await sm.upsertPlanRegistryEntry(planPath, {
							title: metadata?.title,
							description: metadata?.description,
							lifecycle: shouldSetActive ? "active" : "inactive",
						});
					}

					if (!isNewPlan) {
						const activeState = await sm.readActivePlanState(toolCtx.sessionID);
						if (activeState) {
							await sm.upsertPlanRegistryEntry(activeState.active_plan, {
								title: activeState.title,
								description: activeState.description,
								lifecycle: "active",
							});
						}
					}

					const warningCount = result.warnings?.length ?? 0;
					const calculatedStatus = calculatePlanStatus(result.data.phases);
					const statusNote =
						calculatedStatus === "complete"
							? " ✅ Plan marked complete (all tasks done)."
							: "";
					const warningText =
						warningCount > 0
							? ` (${warningCount} warnings: ${result.warnings?.join(", ")})`
							: "";

					const relativePath = relative(directory, planPath);
					const action = isNewPlan
						? isDraftPlan
							? "draft created"
							: "created"
						: "updated";
					const activeNote = isDraftPlan
						? " Draft saved for confirmation; use plan_context_write to persist approvals and plan_promote after the user confirms."
						: isNewPlan && !(shouldSetActive || !existingState)
							? " New plan saved without changing active plan."
							: "";

					return `Plan ${action} at ${relativePath}.${statusNote}${warningText}${activeNote}`;
				},
			}),

			plan_read: tool({
				description: "Read the current implementation plan for this session.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
				},
				async execute(_args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_read requires sessionID. This is a system error.";
					}

					// 1. Try project-scoped active plan first
					const activePlan = await sm.readActivePlanState(toolCtx.sessionID);
					if (activePlan) {
						try {
							const planFile = Bun.file(activePlan.active_plan);
							if (!(await planFile.exists())) {
								return `❌ Active plan file not found at ${activePlan.active_plan}. The plan may have been deleted.`;
							}
							const content = await planFile.text();
							const context = await sm.readPlanContext(activePlan.plan_name);
							if (!context) {
								return content;
							}

							return `${content}\n\n---\n${formatPlanContextBlock({
								...context,
								plan_name: activePlan.plan_name,
							})}`;
						} catch (error) {
							if (isSystemError(error) && error.code === "ENOENT") {
								return `❌ Active plan file not found at ${activePlan.active_plan}. The plan may have been deleted.`;
							}
							throw error;
						}
					}

					// 2. Fall back to legacy session-scoped plan
					const rootID = await getRootSessionID(toolCtx.sessionID);
					const legacyPlanPath = join(legacyBaseDir, rootID, "plan.md");
					try {
						const legacyFile = Bun.file(legacyPlanPath);
						if (!(await legacyFile.exists())) {
							return "No plan found. Use /plan to create a new plan.";
						}
						const content = await legacyFile.text();
						return `${content}\n\n---\n<migration-notice>\nThis plan is from the legacy session-scoped storage. Next time you save, it will be migrated to project-scoped storage at .opencode/workspace/plans/\n</migration-notice>`;
					} catch (error) {
						if (isSystemError(error) && error.code === "ENOENT") {
							return "No plan found. Use /plan to create a new plan.";
						}
						throw error;
					}
				},
			}),

			plan_list: tool({
				description:
					"List all plans in this project. Shows active plan and completed plans.",
				args: {},
				async execute(_args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_list requires sessionID. This is a system error.";
					}

					const activePlan = await sm.readActivePlanState(toolCtx.sessionID);
					const records = await sm.listPlanRecords();

					if (records.length === 0) {
						return "No plans found in .opencode/workspace/plans/. Use /plan to create one.";
					}

					const planList: string[] = [];

					if (activePlan) {
						planList.push(`## Active Plan\n`);
						if (activePlan.title) {
							planList.push(`**Title**: ${activePlan.title}`);
						}
						if (activePlan.description) {
							planList.push(`**Description**: ${activePlan.description}`);
						}
						planList.push(`**Name**: ${activePlan.plan_name}`);
						planList.push(
							`**Path**: ${relative(directory, activePlan.active_plan)}`,
						);
						planList.push(`**Started**: ${activePlan.started_at}`);
						planList.push(
							`**Sessions**: ${activePlan.session_ids.length} session(s) have worked on this plan`,
						);
						planList.push(``);
					}

					const inactivePlans = records.filter(
						(record) =>
							record.lifecycle === "inactive" &&
							record.path !== activePlan?.active_plan,
					);
					const draftPlans = records.filter(
						(record) => record.lifecycle === "draft",
					);

					if (draftPlans.length > 0) {
						planList.push(`## Draft Plans (${draftPlans.length})`);
						for (const record of draftPlans) {
							const relativePath = relative(directory, record.path);
							const context = await sm.readPlanContext(record.plan_name);
							const stageText = context ? `, stage: ${context.stage}` : "";
							planList.push(
								`- **${record.plan_name}**: ${relativePath} (updated: ${record.updated_at}${stageText})`,
							);
						}
						planList.push("");
					}

					if (inactivePlans.length > 0) {
						planList.push(
							`## Other Active-Ready Plans (${inactivePlans.length})`,
						);
						for (const record of inactivePlans) {
							const relativePath = relative(directory, record.path);
							const content = await Bun.file(record.path).text();
							const fm = parsePlanFrontmatter(content);
							const statusText = fm.status ? `, status: ${fm.status}` : "";
							const phaseText = fm.phase ? `, phase: ${fm.phase}` : "";
							planList.push(
								`- **${record.plan_name}**: ${relativePath} (updated: ${record.updated_at}${statusText}${phaseText})`,
							);
						}
					}

					const archivedPlans = records.filter(
						(record) => record.lifecycle === "archived",
					);
					if (archivedPlans.length > 0) {
						planList.push(``);
						planList.push(`## Archived Plans (${archivedPlans.length})`);
						for (const record of archivedPlans) {
							const relativePath = relative(directory, record.path);
							planList.push(
								`- **${record.plan_name}**: ${relativePath} (archived: ${record.archived_at || "unknown"})`,
							);
						}
					}

					return planList.join("\n");
				},
			}),

			plan_set_active: tool({
				description:
					"Set active plan by plan name (timestamp-slug) or plan path suffix. Enables multi-plan workflows.",
				args: {
					identifier: tool.schema
						.string()
						.describe("Plan name or path suffix from plan_list output"),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_set_active requires sessionID. This is a system error.";
					}

					const resolved = await sm.resolvePlanPath(args.identifier);
					if (!resolved) {
						const allPlans = await sm.listPlans();
						if (allPlans.length === 0) {
							return "No plans found in .opencode/workspace/plans/. Use /plan to create one.";
						}

						const names = allPlans.map((path) => getPlanName(path));
						return `❌ Plan not found for identifier "${args.identifier}". Available plans: ${names.join(", ")}`;
					}

					let state: ActivePlanState;
					try {
						state = await sm.setActivePlan(resolved, {
							sessionID: toolCtx.sessionID,
						});
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}

					markCompactionStateDirty(toolCtx.sessionID);

					return `✅ Active plan switched to ${state.plan_name} (${relative(directory, state.active_plan)}).`;
				},
			}),

			plan_promote: tool({
				description:
					"Promote a draft or reviewed plan into the active execution plan after user approval.",
				args: {
					identifier: tool.schema
						.string()
						.describe("Draft plan name or path suffix from plan_list output"),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_promote requires sessionID. This is a system error.";
					}

					try {
						const state = await sm.promotePlan(args.identifier, {
							sessionID: toolCtx.sessionID,
						});
						markCompactionStateDirty(toolCtx.sessionID);
						return `✅ Promoted ${state.plan_name} to the active plan (${relative(directory, state.active_plan)}).`;
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}
				},
			}),

			plan_context_read: tool({
				description:
					"Read structured planning context for the active plan or a named draft/plan.",
				args: {
					plan_name: tool.schema
						.string()
						.optional()
						.describe("Optional plan name. Defaults to the active plan."),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_context_read requires sessionID. This is a system error.";
					}

					let planName = args.plan_name;
					if (!planName) {
						const activePlan = await sm.readActivePlanState(toolCtx.sessionID);
						if (!activePlan) {
							return "No active plan. Use /plan to create one or provide plan_name.";
						}
						planName = activePlan.plan_name;
					}

					const context = await sm.readPlanContext(planName);
					if (!context) {
						return `No structured planning context found for ${planName}.`;
					}

					return formatPlanContextBlock({ ...context, plan_name: planName });
				},
			}),

			plan_context_write: tool({
				description:
					"Persist structured planning context such as confirmations, blast radius, success criteria, and pattern examples.",
				args: {
					plan_name: tool.schema
						.string()
						.optional()
						.describe(
							"Optional target plan name. Defaults to the active plan.",
						),
					stage: tool.schema
						.enum(["draft", "confirmed", "active", "archived"])
						.optional()
						.describe("Planning stage for the stored context."),
					confirmed_by_user: tool.schema
						.boolean()
						.optional()
						.describe(
							"Whether the user has explicitly confirmed this context.",
						),
					goal: tool.schema
						.string()
						.optional()
						.describe("Confirmed goal statement."),
					chosen_pattern: tool.schema
						.string()
						.optional()
						.describe("Chosen repo pattern or implementation approach."),
					affected_areas: tool.schema
						.array(tool.schema.string())
						.optional()
						.describe("Affected files, packages, or subsystems."),
					blast_radius: tool.schema
						.array(tool.schema.string())
						.optional()
						.describe(
							"Explicit blast-radius notes and reversibility constraints.",
						),
					success_criteria: tool.schema
						.array(tool.schema.string())
						.optional()
						.describe("Implementation-ready success criteria."),
					failure_criteria: tool.schema
						.array(tool.schema.string())
						.optional()
						.describe("Failure conditions or fail-closed boundaries."),
					test_plan: tool.schema
						.array(tool.schema.string())
						.optional()
						.describe("Tests and verification steps required before /work."),
					open_risks: tool.schema
						.array(tool.schema.string())
						.optional()
						.describe("Outstanding risks that remain visible to /work."),
					oracle_summary: tool.schema
						.string()
						.optional()
						.describe("Oracle review summary or unresolved review note."),
					question_answers_json: tool.schema
						.string()
						.optional()
						.describe(
							"JSON array of question-answer objects captured from the question tool.",
						),
					pattern_examples_json: tool.schema
						.string()
						.optional()
						.describe("JSON array of confirmed pattern example objects."),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_context_write requires sessionID. This is a system error.";
					}

					let planName = args.plan_name;
					if (!planName) {
						const activePlan = await sm.readActivePlanState(toolCtx.sessionID);
						if (!activePlan) {
							return "No active plan. Provide plan_name for a draft or create a plan first.";
						}
						planName = activePlan.plan_name;
					}

					try {
						const questionAnswers = parseJsonArrayArg({
							value: args.question_answers_json,
							label: "question_answers_json",
							mapper: parsePlanQuestionAnswerInput,
						});
						const patternExamples = parseJsonArrayArg({
							value: args.pattern_examples_json,
							label: "pattern_examples_json",
							mapper: parsePatternExampleInput,
						});

						const patch: PlanContextPatch = {
							stage: args.stage,
							confirmed_by_user: args.confirmed_by_user,
							goal: args.goal,
							chosen_pattern: args.chosen_pattern,
							affected_areas: args.affected_areas,
							blast_radius: args.blast_radius,
							success_criteria: args.success_criteria,
							failure_criteria: args.failure_criteria,
							test_plan: args.test_plan,
							open_risks: args.open_risks,
							oracle_summary: args.oracle_summary,
							question_answers:
								questionAnswers.length > 0 ? questionAnswers : undefined,
							pattern_examples:
								patternExamples.length > 0 ? patternExamples : undefined,
						};

						const context = await sm.syncPlanContext(planName, patch);
						markCompactionStateDirty(toolCtx.sessionID);
						return `✅ Saved structured planning context for ${planName}.\n\n${formatPlanContextBlock(
							{
								...context,
								plan_name: planName,
							},
						)}`;
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}
				},
			}),

			plan_archive: tool({
				description:
					"Archive a plan so it is excluded from active rotation. If the active plan is archived, another non-archived plan becomes active automatically.",
				args: {
					identifier: tool.schema
						.string()
						.describe("Plan name or path suffix from plan_list output"),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_archive requires sessionID. This is a system error.";
					}

					try {
						const result = await sm.archivePlan(args.identifier, {
							sessionID: toolCtx.sessionID,
						});

						markCompactionStateDirty(toolCtx.sessionID);

						const archivedPath = relative(directory, result.archived.path);
						if (result.activePlan) {
							const activePath = relative(
								directory,
								result.activePlan.active_plan,
							);
							return `✅ Archived ${result.archived.plan_name} (${archivedPath}). Active plan is now ${result.activePlan.plan_name} (${activePath}).`;
						}

						return `✅ Archived ${result.archived.plan_name} (${archivedPath}). No active plan remains.`;
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}
				},
			}),

			plan_unarchive: tool({
				description:
					"Unarchive a plan so it can be activated again via plan_set_active.",
				args: {
					identifier: tool.schema
						.string()
						.describe("Plan name or path suffix from plan_list output"),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_unarchive requires sessionID. This is a system error.";
					}

					try {
						const record = await sm.unarchivePlan(args.identifier);
						markCompactionStateDirty(toolCtx.sessionID);
						const nextStep =
							record.lifecycle === "draft"
								? "Review and promote it with plan_promote when ready."
								: "Use plan_set_active to switch to it.";
						return `✅ Unarchived ${record.plan_name} (${relative(directory, record.path)}). ${nextStep}`;
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}
				},
			}),

			// ── Mode Transition Tools ──────────────────────────

			// ── Plan Docs Tools (progressive loading + bidirectional links) ──

			plan_doc_link: tool({
				description:
					"Link PRD/RFC/ticket/docs to the active plan (optionally scoped to phase/task). Stores bidirectional links in workspace metadata.",
				args: {
					path: tool.schema
						.string()
						.describe("Path to doc file (relative to project or absolute)"),
					type: tool.schema
						.enum(["prd", "rfc", "ticket", "notes", "other"])
						.describe("Document type"),
					title: tool.schema
						.string()
						.optional()
						.describe("Optional human-friendly title"),
					phase: tool.schema
						.string()
						.optional()
						.describe("Optional phase number/name scope (example: '2')"),
					task: tool.schema
						.string()
						.optional()
						.describe("Optional task scope (example: '2.3')"),
					notes: tool.schema
						.string()
						.optional()
						.describe("Optional why/when this doc matters"),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_doc_link requires sessionID. This is a system error.";
					}

					const activePlan = await sm.readActivePlanState(toolCtx.sessionID);
					if (!activePlan) {
						return "No active plan. Create a plan first with /plan.";
					}

					const absoluteDocPath = toAbsoluteDocPath(args.path);
					const docFile = Bun.file(absoluteDocPath);
					if (!(await docFile.exists())) {
						return `❌ Doc file not found: ${absoluteDocPath}`;
					}

					const content = await docFile.text();
					const headingMatch = content.match(/^#\s+(.+)$/m);

					const linkInput: LinkPlanDocInput = {
						path: absoluteDocPath,
						type: args.type as PlanDocType,
						title: args.title || headingMatch?.[1]?.trim(),
						phase: args.phase,
						task: args.task,
						notes: args.notes,
					};

					const link = await sm.linkPlanDoc(activePlan.plan_name, linkInput);
					markCompactionStateDirty(toolCtx.sessionID);

					const displayPath = absoluteDocPath.startsWith(directory)
						? relative(directory, absoluteDocPath)
						: absoluteDocPath;

					return `✅ Linked doc ${link.id} to plan ${activePlan.plan_name}: ${displayPath}`;
				},
			}),

			plan_doc_list: tool({
				description:
					"List docs linked to a plan, including phase/task scoping and reverse usage references.",
				args: {
					plan_name: tool.schema
						.string()
						.optional()
						.describe("Optional plan name. Defaults to active plan."),
					phase: tool.schema
						.string()
						.optional()
						.describe("Optional phase filter"),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_doc_list requires sessionID. This is a system error.";
					}

					const activePlan = await sm.readActivePlanState(toolCtx.sessionID);
					const targetPlan = args.plan_name || activePlan?.plan_name;

					if (!targetPlan) {
						return "No active plan. Use plan_set_active or create a plan first.";
					}

					const links = await sm.getPlanDocLinks(targetPlan);
					const filtered = args.phase
						? links.filter((link) => !link.phase || link.phase === args.phase)
						: links;

					if (filtered.length === 0) {
						return `No linked docs found for plan ${targetPlan}${args.phase ? ` (phase ${args.phase})` : ""}.`;
					}

					const registry = await sm.readPlanDocRegistry();
					const lines: string[] = [`## Linked Docs for ${targetPlan}`];

					for (const link of filtered) {
						const displayPath = link.path.startsWith(directory)
							? relative(directory, link.path)
							: link.path;
						const scope: string[] = [];
						if (link.phase) scope.push(`phase ${link.phase}`);
						if (link.task) scope.push(`task ${link.task}`);
						const scopeText = scope.length > 0 ? ` (${scope.join(", ")})` : "";

						const backlinks = registry.docs[link.id]?.linked_plans || [];
						lines.push(
							`- [${link.type}] **${link.title || link.id}**${scopeText}`,
						);
						lines.push(`  id: ${link.id}`);
						lines.push(`  path: ${displayPath}`);
						lines.push(`  linked in ${backlinks.length} plan reference(s)`);
						if (link.notes) lines.push(`  notes: ${link.notes}`);
					}

					return lines.join("\n");
				},
			}),

			plan_doc_load: tool({
				description:
					"Progressively load linked doc context (summary/full/section). Use doc_id from plan_doc_list for stable retrieval.",
				args: {
					doc_id: tool.schema
						.string()
						.optional()
						.describe("Linked doc ID from plan_doc_list"),
					path: tool.schema
						.string()
						.optional()
						.describe("Doc path (used when doc_id is unavailable)"),
					mode: tool.schema
						.enum(["summary", "full", "section"])
						.optional()
						.describe("Loading depth. summary is default."),
					section: tool.schema
						.string()
						.optional()
						.describe("Section heading to load when mode='section'"),
				},
				async execute(args) {
					const mode = args.mode ?? "summary";

					let targetPath: string | null = null;
					let targetID: string | null = null;
					let backlinksText = "";

					if (args.doc_id) {
						const entry = await sm.getPlanDocByID(args.doc_id);
						if (!entry) {
							return `❌ No linked doc found for id ${args.doc_id}.`;
						}

						targetPath = entry.path;
						targetID = entry.id;
						if (entry.linked_plans.length > 0) {
							const refs = entry.linked_plans
								.map(
									(ref) =>
										`${ref.plan_name}${ref.phase ? `:phase-${ref.phase}` : ""}${ref.task ? `:task-${ref.task}` : ""}`,
								)
								.join(", ");
							backlinksText = `\nLinked from: ${refs}`;
						}
					} else if (args.path) {
						targetPath = toAbsoluteDocPath(args.path);
					} else {
						return "❌ Provide either doc_id or path.";
					}

					const file = Bun.file(targetPath);
					if (!(await file.exists())) {
						return `❌ Doc file not found: ${targetPath}`;
					}

					const content = await file.text();
					let payload = content;

					if (mode === "summary") {
						payload =
							content.length > 6000
								? `${content.slice(0, 6000)}\n...`
								: content;
					}

					if (mode === "section") {
						if (!args.section) {
							return "❌ section is required when mode='section'.";
						}

						const section = readSectionByHeading(content, args.section);
						if (!section) {
							return `❌ Section '${args.section}' not found in document.`;
						}
						payload = section;
					}

					const displayPath = targetPath.startsWith(directory)
						? relative(directory, targetPath)
						: targetPath;

					const header = `# Plan Doc Load\nmode: ${mode}\npath: ${displayPath}${targetID ? `\ndoc_id: ${targetID}` : ""}${backlinksText}\n`;
					return `${header}\n\n${payload}`;
				},
			}),

			continuation_status: tool({
				description:
					"Read continuation mode for a session (running|stopped|handoff).",
				args: {
					session_id: tool.schema
						.string()
						.optional()
						.describe(
							"Optional target session ID. Defaults to current session.",
						),
				},
				async execute(args, toolCtx) {
					if (!hookConfig.features.continuationCommands) {
						return "❌ continuation_status is disabled. Enable features.continuationCommands in workspace.json.";
					}

					const sessionID = args.session_id ?? toolCtx?.sessionID;
					if (!sessionID) {
						return "❌ continuation_status requires sessionID. This is a system error.";
					}

					const record = await continuationState.getSession(sessionID);
					return JSON.stringify(
						record ?? {
							session_id: sessionID,
							mode: "running",
							updated_at: new Date().toISOString(),
						},
						null,
						2,
					);
				},
			}),

			continuation_continue: tool({
				description:
					"Resume continuation mode for a session with idempotent state transition.",
				args: {
					session_id: tool.schema
						.string()
						.optional()
						.describe(
							"Optional target session ID. Defaults to current session.",
						),
					idempotency_key: tool.schema
						.string()
						.optional()
						.describe("Optional idempotency key for safe retries."),
				},
				async execute(args, toolCtx) {
					if (!hookConfig.features.continuationCommands) {
						return "❌ continuation_continue is disabled. Enable features.continuationCommands in workspace.json.";
					}

					const sessionID = args.session_id ?? toolCtx?.sessionID;
					if (!sessionID) {
						return "❌ continuation_continue requires sessionID. This is a system error.";
					}

					if (hookConfig.features.boundaryPolicyV2 && !args.idempotency_key) {
						return "❌ continuation_continue requires idempotency_key when features.boundaryPolicyV2 is enabled.";
					}

					const updated = await continuationState.setSessionMode({
						session_id: sessionID,
						mode: "running",
						idempotency_key: args.idempotency_key,
					});
					markCompactionStateDirty(sessionID);
					return JSON.stringify(updated, null, 2);
				},
			}),

			continuation_handoff: tool({
				description:
					"Mark session as handoff with target owner and summary for continuity.",
				args: {
					to: tool.schema
						.string()
						.describe("Handoff target (agent, owner, or role label)."),
					summary: tool.schema
						.string()
						.describe("Brief handoff summary for next implementer."),
					session_id: tool.schema
						.string()
						.optional()
						.describe(
							"Optional target session ID. Defaults to current session.",
						),
					idempotency_key: tool.schema
						.string()
						.optional()
						.describe("Optional idempotency key for safe retries."),
				},
				async execute(args, toolCtx) {
					if (!hookConfig.features.continuationCommands) {
						return "❌ continuation_handoff is disabled. Enable features.continuationCommands in workspace.json.";
					}

					const sessionID = args.session_id ?? toolCtx?.sessionID;
					if (!sessionID) {
						return "❌ continuation_handoff requires sessionID. This is a system error.";
					}

					if (hookConfig.features.boundaryPolicyV2 && !args.idempotency_key) {
						return "❌ continuation_handoff requires idempotency_key when features.boundaryPolicyV2 is enabled.";
					}

					const updated = await continuationState.setSessionMode({
						session_id: sessionID,
						mode: "handoff",
						handoff_to: args.to.trim(),
						handoff_summary: args.summary.trim(),
						idempotency_key: args.idempotency_key,
					});
					markCompactionStateDirty(sessionID);
					return JSON.stringify(updated, null, 2);
				},
			}),

			continuation_stop: tool({
				description:
					"Stop continuation prompts for a session with optional reason.",
				args: {
					reason: tool.schema
						.string()
						.optional()
						.describe("Optional reason for stop state."),
					session_id: tool.schema
						.string()
						.optional()
						.describe(
							"Optional target session ID. Defaults to current session.",
						),
					idempotency_key: tool.schema
						.string()
						.optional()
						.describe("Optional idempotency key for safe retries."),
				},
				async execute(args, toolCtx) {
					if (!hookConfig.features.continuationCommands) {
						return "❌ continuation_stop is disabled. Enable features.continuationCommands in workspace.json.";
					}

					const sessionID = args.session_id ?? toolCtx?.sessionID;
					if (!sessionID) {
						return "❌ continuation_stop requires sessionID. This is a system error.";
					}

					if (hookConfig.features.boundaryPolicyV2 && !args.idempotency_key) {
						return "❌ continuation_stop requires idempotency_key when features.boundaryPolicyV2 is enabled.";
					}

					const updated = await continuationState.setSessionMode({
						session_id: sessionID,
						mode: "stopped",
						reason: args.reason?.trim(),
						idempotency_key: args.idempotency_key,
					});
					markCompactionStateDirty(sessionID);
					return JSON.stringify(updated, null, 2);
				},
			}),

			mcp_oauth_helper: tool({
				description:
					"Inspect OAuth-capable MCP configuration and report actionable auth guidance.",
				args: {
					server: tool.schema
						.string()
						.optional()
						.describe("Optional MCP server ID filter."),
				},
				async execute(args) {
					if (!hookConfig.features.mcpOAuthHelper) {
						return "❌ mcp_oauth_helper is disabled. Enable features.mcpOAuthHelper in workspace.json.";
					}

					const snapshot = await buildMcpOAuthHelperSnapshot({
						directory,
						homeDirectory: homedir(),
						server: args.server?.trim(),
					});

					return JSON.stringify(snapshot, null, 2);
				},
			}),

			mcp0_health: tool({
				description:
					"Inspect mcp0 facade configuration and report readiness/fallback guidance.",
				args: {},
				async execute() {
					if (!hookConfig.features.mcpOAuthHelper) {
						return "❌ mcp0_health is disabled. Enable features.mcpOAuthHelper in workspace.json.";
					}

					const snapshot = await buildMcp0HealthSnapshot({
						directory,
						homeDirectory: homedir(),
					});

					return JSON.stringify(snapshot, null, 2);
				},
			}),

			// ── Notepad Tools ──────────────────────────────────

			notepad_read: tool({
				description:
					"Read accumulated wisdom from the notepad for the active plan. Returns learnings, issues, and decisions discovered during implementation. ALWAYS read before delegating tasks to pass inherited wisdom.",
				args: {
					file: tool.schema
						.enum(["all", "learnings", "issues", "decisions"])
						.optional()
						.describe("Which notepad file to read. Defaults to 'all'."),
				},
				async execute(args) {
					const notepadDir = await sm.getNotepadDir();
					if (!notepadDir) {
						return "No active plan. Create a plan first with /plan, then use notepad to record learnings.";
					}

					const fileToRead = args.file ?? "all";
					const results: string[] = [];

					if (fileToRead === "all") {
						for (const file of NOTEPAD_FILES) {
							const content = await sm.readNotepadFile(file);
							if (content) {
								results.push(`--- ${file} ---\n${content}`);
							}
						}
					} else {
						const content = await sm.readNotepadFile(
							`${fileToRead}.md` as NotepadFile,
						);
						if (content) {
							results.push(content);
						}
					}

					if (results.length === 0) {
						const activePlan = await sm.readActivePlanState();
						return `Notepad is empty for plan "${activePlan?.plan_name}". Use notepad_write to record learnings, issues, or decisions.`;
					}

					return results.join("\n\n");
				},
			}),

			notepad_write: tool({
				description:
					"Append learnings, issues, or decisions to the notepad for the active plan. Use this to persist wisdom across sessions and share with subagents.",
				args: {
					file: tool.schema
						.enum(["learnings", "issues", "decisions"])
						.describe(
							"Which notepad file to write to. learnings=patterns/conventions, issues=gotchas/problems, decisions=rationales",
						),
					content: tool.schema
						.string()
						.describe(
							"The content to append. Will be timestamped automatically.",
						),
				},
				async execute(args) {
					try {
						await sm.appendToNotepadFile(
							`${args.file}.md` as NotepadFile,
							args.content,
						);
						const notepadDir = await sm.getNotepadDir();
						if (!notepadDir) {
							return `✅ Appended to ${args.file}.md`;
						}
						const relativePath = relative(directory, notepadDir);
						return `✅ Appended to ${relativePath}/${args.file}.md`;
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}
				},
			}),

			// ── Worktree Tools ──────────────────────────────
			...worktreeTools,

			notepad_list: tool({
				description:
					"List all notepad files for the active plan with their sizes.",
				args: {},
				async execute() {
					const notepadDir = await sm.getNotepadDir();
					if (!notepadDir) {
						return "No active plan. Create a plan first with /plan.";
					}

					const activePlan = await sm.readActivePlanState();
					const results: string[] = [
						`## Notepad for "${activePlan?.plan_name}"\n`,
					];
					results.push(`Path: ${relative(directory, notepadDir)}/\n`);

					let hasFiles = false;
					for (const file of NOTEPAD_FILES) {
						try {
							const filePath = join(notepadDir, file);
							const bunFile = Bun.file(filePath);
							if (!(await bunFile.exists())) {
								results.push(`- **${file}**: (not created)`);
								continue;
							}
							const content = await bunFile.text();
							const lineCount = content.split("\n").length;
							results.push(
								`- **${file}**: ${lineCount} lines, ${bunFile.size} bytes`,
							);
							hasFiles = true;
						} catch (error) {
							if (isSystemError(error) && error.code === "ENOENT") {
								results.push(`- **${file}**: (not created)`);
							} else {
								throw error;
							}
						}
					}

					if (!hasFiles) {
						results.push(
							"\nNo notepad files yet. Use notepad_write to start recording wisdom.",
						);
					}

					return results.join("\n");
				},
			}),
		},

		event: eventHook,

		hook,
	};
};

export default WorkspacePlugin;


// ── Test Exports (backward compatibility) ──────────────────
export { extractMarkdownParts, parsePlanMarkdown } from "./plan/schema.js";
export { formatGitStats } from "./utils.js";
