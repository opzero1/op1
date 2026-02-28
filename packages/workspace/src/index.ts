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
import { summarizeAgentStatus } from "./agent-status.js";
import {
	getApprovalRiskTier,
	normalizeApprovalToolName,
	shouldEnforceApproval,
} from "./approval/policy.js";
import {
	type ApprovalAuditReason,
	createApprovalStateManager,
} from "./approval/state.js";
import { homedir, join, mkdir, relative, resolve } from "./bun-compat.js";
import { createContextScoutStateManager } from "./context-scout/state.js";
import { createContinuationStateManager } from "./continuation/state.js";
import {
	type DelegationCategory,
	type DelegationRoutingTelemetry,
	parseDelegationCategory,
	resolveDelegationRouting,
} from "./delegation/router.js";
import {
	createDelegationStateManager,
	type DelegationStatus,
} from "./delegation/state.js";
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
import { discoverClaudeCompatAssets } from "./interop/claude-compat.js";
import { buildMcpOAuthHelperSnapshot } from "./interop/mcp-oauth-helper.js";

import { formatParseError, parsePlanMarkdown } from "./plan/schema.js";
import {
	type ActivePlanState,
	createStateManager,
	generatePlanMetadata,
	generatePlanPath,
	getPlanName,
	type LinkPlanDocInput,
	NOTEPAD_FILES,
	type NotepadFile,
	type PlanDocType,
} from "./plan/state.js";
import { autoUpdatePlanStatus, calculatePlanStatus } from "./plan/status.js";
import {
	executeSessionInfo,
	executeSessionList,
	executeSessionRead,
	executeSessionSearch,
} from "./session-history.js";
import { createSkillPointerResolver } from "./skill-pointer/resolve.js";
import { buildTaskGraph } from "./task-graph/graph.js";
import { getProjectId, isSystemError } from "./utils.js";
import { createWorktreeTools } from "./worktree/index.js";

interface DelegationClient {
	session: {
		create: (input: {
			body?: {
				title?: string;
				parentID?: string;
			};
		}) => Promise<{ data?: unknown }>;
		promptAsync: (input: {
			path: { id: string };
			body: {
				agent?: string;
				parts: Array<{ type: "text"; text: string }>;
				tools?: Record<string, boolean>;
			};
		}) => Promise<unknown>;
		messages: (input: {
			path: { id: string };
			query?: { limit?: number };
		}) => Promise<{ data?: unknown }>;
		abort: (input: { path: { id: string } }) => Promise<unknown>;
	};
}

interface WorkspaceRuntimeEvent {
	type?: string;
	properties?: Record<string, unknown>;
}

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
	const approvalState = createApprovalStateManager(workspaceDir);
	const delegationState = createDelegationStateManager(workspaceDir);
	const contextScoutState = createContextScoutStateManager(workspaceDir);
	const continuationState = createContinuationStateManager(workspaceDir);
	const delegationClient = ctx.client as unknown as DelegationClient;

	// Hook configuration (global + project config + env overrides)
	const hookConfig: ResolvedHookConfig = await loadHookConfig(directory);
	const skillPointerResolver = createSkillPointerResolver({
		enabled: hookConfig.features.skillPointer,
		skillsRoot: join(homedir(), ".config", "opencode", "skills"),
		externalSkillRoots: hookConfig.features.claudeCompatibility
			? [
					join(directory, ".claude"),
					join(directory, ".agents"),
					join(homedir(), ".claude"),
					join(homedir(), ".agents"),
				]
			: [],
	});

	if (hookConfig.features.skillPointer) {
		const skillPointerIntegrity = await skillPointerResolver.validateIndex();
		if (!skillPointerIntegrity.ok) {
			hookConfig.features.skillPointer = false;
		}
	}

	// ── Session helpers ────────────────────────────────────

	const ID_WORDS_A = [
		"agile",
		"amber",
		"brisk",
		"calm",
		"clear",
		"cosmic",
		"crisp",
		"daring",
		"eager",
		"gentle",
		"golden",
		"lively",
		"mighty",
		"nimble",
		"proud",
		"quiet",
		"rapid",
		"silver",
		"steady",
		"swift",
	] as const;

	const ID_WORDS_B = [
		"aqua",
		"aurora",
		"beacon",
		"cedar",
		"dawn",
		"ember",
		"forest",
		"harbor",
		"jade",
		"lagoon",
		"maple",
		"meadow",
		"neon",
		"ocean",
		"orchid",
		"pixel",
		"rocket",
		"sierra",
		"solar",
		"tidal",
	] as const;

	const ID_WORDS_C = [
		"anchor",
		"badger",
		"falcon",
		"harvest",
		"island",
		"lantern",
		"mariner",
		"nebula",
		"otter",
		"pioneer",
		"quartz",
		"ranger",
		"sailor",
		"summit",
		"thunder",
		"vector",
		"voyager",
		"willow",
		"zephyr",
		"zenith",
	] as const;

	function pickWord(words: readonly string[]): string {
		return words[Math.floor(Math.random() * words.length)] || "swift";
	}

	async function generateDelegationID(): Promise<string> {
		for (let attempt = 0; attempt < 64; attempt += 1) {
			const candidate = `${pickWord(ID_WORDS_A)}-${pickWord(ID_WORDS_B)}-${pickWord(ID_WORDS_C)}`;
			const existing = await delegationState.getDelegation(candidate);
			if (!existing) return candidate;
		}

		throw new Error(
			"Failed to generate unique delegation ID after multiple attempts",
		);
	}

	function getSessionIDFromCreateResponse(data: unknown): string | null {
		if (!data || typeof data !== "object") return null;
		const record = data as Record<string, unknown>;
		return typeof record.id === "string" ? record.id : null;
	}

	function getEventSessionID(event: WorkspaceRuntimeEvent): string | null {
		const properties = event.properties;
		if (!properties) return null;

		if (typeof properties.sessionID === "string") {
			return properties.sessionID;
		}

		if (typeof properties.id === "string") {
			return properties.id;
		}

		const info = properties.info;
		if (info && typeof info === "object") {
			const infoRecord = info as Record<string, unknown>;
			if (typeof infoRecord.sessionID === "string") {
				return infoRecord.sessionID;
			}
			if (typeof infoRecord.id === "string") {
				return infoRecord.id;
			}
		}

		return null;
	}

	function getEventError(event: WorkspaceRuntimeEvent): string {
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

	function extractLatestAssistantText(data: unknown): string | null {
		if (!Array.isArray(data)) return null;

		for (let index = data.length - 1; index >= 0; index -= 1) {
			const item = data[index];
			if (!item || typeof item !== "object") continue;

			const record = item as Record<string, unknown>;
			const info = record.info;
			if (!info || typeof info !== "object") continue;

			const infoRecord = info as Record<string, unknown>;
			if (infoRecord.role !== "assistant") continue;

			const parts = record.parts;
			if (!Array.isArray(parts)) continue;

			const textParts = parts
				.filter((part): part is Record<string, unknown> => {
					return !!part && typeof part === "object";
				})
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => String(part.text).trim())
				.filter((part) => part.length > 0);

			if (textParts.length > 0) {
				return textParts.join("\n");
			}
		}

		return null;
	}

	async function getLatestAssistantResult(
		sessionID: string,
	): Promise<string | null> {
		const response = await delegationClient.session.messages({
			path: { id: sessionID },
			query: { limit: 30 },
		});
		return extractLatestAssistantText(response.data);
	}

	async function startDelegationSession(input: {
		record: {
			id: string;
			child_session_id: string;
			agent: string;
			prompt: string;
		};
	}): Promise<void> {
		await delegationClient.session.promptAsync({
			path: { id: input.record.child_session_id },
			body: {
				agent: input.record.agent,
				parts: [{ type: "text", text: input.record.prompt }],
				tools: {
					delegate: false,
					delegation_read: false,
					delegation_list: false,
					delegation_cancel: false,
				},
			},
		});
	}

	async function promoteRunnableBlockedDelegations(
		rootSessionID: string,
	): Promise<void> {
		const runnable = await delegationState.listRunnableBlockedDelegations({
			root_session_id: rootSessionID,
			limit: 20,
		});

		for (const record of runnable) {
			try {
				await startDelegationSession({ record });
				const running = await delegationState.transitionDelegation(
					record.id,
					"running",
				);
				markCompactionStateDirty(running.parent_session_id);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				try {
					const failed = await delegationState.transitionDelegation(
						record.id,
						"failed",
						{ error: message },
					);
					markCompactionStateDirty(failed.parent_session_id);
				} catch {
					// Best effort only.
				}
			}
		}
	}

	function formatDelegationStatusOutput(input: {
		delegation_id: string;
		status: DelegationStatus;
		agent: string;
		category?: DelegationCategory;
		routing?: DelegationRoutingTelemetry;
		tmux_session_name?: string;
		tmux_window_name?: string;
		depends_on?: string[];
		blocked_by?: string[];
		child_session_id: string;
		created_at: string;
		updated_at: string;
		started_at?: string;
		completed_at?: string;
		result?: string;
		error?: string;
	}): string {
		return JSON.stringify(
			{
				...input,
				reference: `ref:${input.delegation_id}`,
			},
			null,
			2,
		);
	}

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

	interface ApprovalToolContext {
		sessionID?: string;
		ask?: (input: {
			permission: string;
			patterns: string[];
			always: string[];
			metadata: Record<string, unknown>;
		}) => Promise<void>;
	}

	function isNonInteractiveApprovalError(message: string): boolean {
		const normalized = message.toLowerCase();
		return (
			normalized.includes("non-interactive") ||
			normalized.includes("headless") ||
			normalized.includes("tty") ||
			normalized.includes("interactive") ||
			normalized.includes("cannot ask")
		);
	}

	async function writeApprovalAudit(input: {
		sessionID: string;
		tool: string;
		outcome: "approved" | "denied" | "blocked";
		reason: ApprovalAuditReason;
		expiresAt?: string;
		detail?: string;
		metadata?: Record<string, string | number | boolean>;
	}): Promise<void> {
		try {
			await approvalState.recordAudit({
				session_id: input.sessionID,
				tool: input.tool,
				outcome: input.outcome,
				reason: input.reason,
				expires_at: input.expiresAt,
				detail: input.detail,
				metadata: input.metadata,
			});
		} catch {
			// Approval auditing should not crash tool execution.
		}
	}

	async function enforceApprovalGate(input: {
		toolName: string;
		toolCtx?: ApprovalToolContext;
		reason: string;
		metadata?: Record<string, string | number | boolean>;
	}): Promise<string | null> {
		const normalizedTool = normalizeApprovalToolName(input.toolName);
		if (!normalizedTool) return null;

		const shouldGate = shouldEnforceApproval({
			toolName: normalizedTool,
			featureEnabled: hookConfig.features.approvalGate,
			policy: hookConfig.approval,
		});
		if (!shouldGate) return null;

		if (!input.toolCtx?.sessionID) {
			return `❌ ${normalizedTool} requires sessionID for approval-gated execution.`;
		}

		const rootSessionID = await getRootSessionID(input.toolCtx.sessionID);
		const cached = await approvalState.getActiveGrant(
			rootSessionID,
			normalizedTool,
		);
		if (cached) {
			await writeApprovalAudit({
				sessionID: rootSessionID,
				tool: normalizedTool,
				outcome: "approved",
				reason: "cached_grant",
				expiresAt: cached.expires_at,
				metadata: input.metadata,
			});
			return null;
		}

		if (!input.toolCtx.ask) {
			await writeApprovalAudit({
				sessionID: rootSessionID,
				tool: normalizedTool,
				outcome: "blocked",
				reason: "prompt_unavailable",
				detail: "Approval prompt unavailable in this session.",
				metadata: input.metadata,
			});
			return `❌ ${normalizedTool} is approval-gated and cannot run because prompts are unavailable in this session.`;
		}

		try {
			const riskTier = getApprovalRiskTier(normalizedTool);
			await input.toolCtx.ask({
				permission: "task",
				patterns: [normalizedTool],
				always: ["*"],
				metadata: {
					approval_gate: true,
					approval_tool: normalizedTool,
					approval_reason: input.reason,
					approval_ttl_ms: hookConfig.approval.ttlMs,
					approval_risk_tier: riskTier ?? "medium",
					...(input.metadata ?? {}),
				},
			});

			const requestID = crypto.randomUUID();
			const grant = await approvalState.approveTool({
				sessionID: rootSessionID,
				tool: normalizedTool,
				ttlMs: hookConfig.approval.ttlMs,
				requestID,
			});

			await writeApprovalAudit({
				sessionID: rootSessionID,
				tool: normalizedTool,
				outcome: "approved",
				reason: "prompt_approved",
				expiresAt: grant?.expires_at,
				metadata: input.metadata,
			});

			return null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const nonInteractive = isNonInteractiveApprovalError(message);

			await writeApprovalAudit({
				sessionID: rootSessionID,
				tool: normalizedTool,
				outcome: nonInteractive ? "blocked" : "denied",
				reason: nonInteractive ? "non_interactive_blocked" : "prompt_denied",
				detail: message,
				metadata: input.metadata,
			});

			if (nonInteractive) {
				return `❌ ${normalizedTool} is approval-gated and blocked in non-interactive sessions (policy: fail-closed).`;
			}

			return `❌ ${normalizedTool} requires approval and was denied or cancelled.`;
		}
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
		enforceApproval: async (input) => {
			return enforceApprovalGate({
				toolName: input.toolName,
				toolCtx: input.toolCtx,
				reason: input.reason,
				metadata: input.metadata,
			});
		},
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
		try {
			const eventValue = payload.event;
			if (!eventValue || typeof eventValue !== "object") return;

			const event = eventValue as WorkspaceRuntimeEvent;
			const eventType = event.type;
			if (
				eventType !== "session.idle" &&
				eventType !== "session.error" &&
				eventType !== "session.deleted" &&
				eventType !== "session.interrupt"
			) {
				return;
			}

			const sessionID = getEventSessionID(event);
			if (!sessionID) return;

			const delegation =
				await delegationState.getDelegationByChildSessionID(sessionID);
			if (!delegation) return;

			if (delegation.status !== "queued" && delegation.status !== "running") {
				return;
			}

			if (eventType === "session.idle") {
				try {
					const result = await getLatestAssistantResult(sessionID);
					const updated = await delegationState.transitionDelegation(
						delegation.id,
						"succeeded",
						{
							result: result ?? undefined,
						},
					);
					markCompactionStateDirty(updated.parent_session_id);
					await promoteRunnableBlockedDelegations(updated.root_session_id);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					const updated = await delegationState.transitionDelegation(
						delegation.id,
						"failed",
						{
							error: message,
						},
					);
					markCompactionStateDirty(updated.parent_session_id);
				}
				return;
			}

			if (eventType === "session.error") {
				const updated = await delegationState.transitionDelegation(
					delegation.id,
					"failed",
					{
						error: getEventError(event),
					},
				);
				markCompactionStateDirty(updated.parent_session_id);
				return;
			}

			if (
				eventType === "session.deleted" ||
				eventType === "session.interrupt"
			) {
				const updated = await delegationState.transitionDelegation(
					delegation.id,
					"cancelled",
					{
						error:
							eventType === "session.interrupt"
								? "Delegation session interrupted."
								: "Delegation session deleted.",
					},
				);
				markCompactionStateDirty(updated.parent_session_id);
			}
		} catch {
			// Delegation event handling must remain non-fatal.
		}
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

			agent_status: tool({
				description:
					"Read-only health summary for current root session using delegation signals (healthy|degraded|stuck).",
				args: {
					stuck_after_ms: tool.schema
						.number()
						.int()
						.min(1000)
						.max(24 * 60 * 60 * 1000)
						.optional()
						.describe(
							"Stuck threshold for running delegations in milliseconds (default: 20m).",
						),
					queue_degraded_after_ms: tool.schema
						.number()
						.int()
						.min(1000)
						.max(24 * 60 * 60 * 1000)
						.optional()
						.describe(
							"Queue staleness threshold in milliseconds for degraded status (default: 5m).",
						),
					failure_window_ms: tool.schema
						.number()
						.int()
						.min(1000)
						.max(24 * 60 * 60 * 1000)
						.optional()
						.describe(
							"Time window to count recent failed delegations in milliseconds (default: 15m).",
						),
					limit: tool.schema
						.number()
						.int()
						.min(1)
						.max(300)
						.optional()
						.describe(
							"Maximum delegations to analyze from current root session scope (default: 100).",
						),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ agent_status requires sessionID. This is a system error.";
					}

					const rootSessionID = await getRootSessionID(toolCtx.sessionID);
					const limit = args.limit ?? 100;
					const records = await delegationState.listDelegations({
						root_session_id: rootSessionID,
						limit,
					});

					const snapshot = summarizeAgentStatus(records, {
						nowMs: Date.now(),
						stuckAfterMs: args.stuck_after_ms,
						queueDegradedAfterMs: args.queue_degraded_after_ms,
						failureWindowMs: args.failure_window_ms,
					});

					const runningSample = records
						.filter((record) => record.status === "running")
						.slice(0, 5)
						.map((record) => ({
							id: record.id,
							agent: record.agent,
							started_at: record.started_at,
							updated_at: record.updated_at,
							created_at: record.created_at,
						}));

					return JSON.stringify(
						{
							root_session_id: rootSessionID,
							...snapshot,
							running_sample: runningSample,
						},
						null,
						2,
					);
				},
			}),

			plan_save: tool({
				description:
					"Save the implementation plan as markdown. Must include citations (ref:delegation-id) for decisions based on research. Plan is validated before saving.",
				args: {
					content: tool.schema
						.string()
						.describe("The full plan in markdown format"),
					mode: tool.schema
						.enum(["active", "new"])
						.optional()
						.describe(
							"'active' updates current active plan. 'new' creates a new plan file.",
						),
					set_active: tool.schema
						.boolean()
						.optional()
						.describe(
							"When mode='new', set this new plan as active (default: true).",
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
						mode === "new" ? (args.set_active ?? true) : true;

					let planPath: string;
					let isNewPlan = false;
					let metadata: { title: string; description: string } | undefined;

					if (mode === "active" && existingState) {
						planPath = existingState.active_plan;

						if (!existingState.session_ids.includes(toolCtx.sessionID)) {
							existingState.session_ids.push(toolCtx.sessionID);
							await sm.writeActivePlanState(existingState);
						}
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

					if (isNewPlan && (shouldSetActive || !existingState)) {
						await sm.setActivePlan(planPath, {
							sessionID: toolCtx.sessionID,
							title: metadata?.title,
							description: metadata?.description,
						});
					} else {
						await sm.upsertPlanRegistryEntry(planPath, {
							title: metadata?.title,
							description: metadata?.description,
							lifecycle: "inactive",
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
					const action = isNewPlan ? "created" : "updated";
					const activeNote =
						isNewPlan && !(shouldSetActive || !existingState)
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
							return await planFile.text();
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

					const approvalBlocked = await enforceApprovalGate({
						toolName: "plan_archive",
						toolCtx,
						reason: `Archive plan '${args.identifier}'.`,
						metadata: {
							identifier: args.identifier,
						},
					});
					if (approvalBlocked) {
						return approvalBlocked;
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

					const approvalBlocked = await enforceApprovalGate({
						toolName: "plan_unarchive",
						toolCtx,
						reason: `Unarchive plan '${args.identifier}'.`,
						metadata: {
							identifier: args.identifier,
						},
					});
					if (approvalBlocked) {
						return approvalBlocked;
					}

					try {
						const record = await sm.unarchivePlan(args.identifier);
						markCompactionStateDirty(toolCtx.sessionID);
						return `✅ Unarchived ${record.plan_name} (${relative(directory, record.path)}). Use plan_set_active to switch to it.`;
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}
				},
			}),

			// ── Mode Transition Tools ──────────────────────────

			plan_enter: tool({
				description:
					"Signal intent to enter planning mode. Returns instructions for creating a structured implementation plan. Use when a task is complex and requires upfront planning before implementation.",
				args: {
					reason: tool.schema
						.string()
						.describe(
							"Why planning mode is needed (e.g., 'complex multi-step feature', 'architectural decision')",
						),
				},
				async execute(args) {
					const activePlan = await sm.readActivePlanState();

					if (activePlan) {
						const relativePath = relative(directory, activePlan.active_plan);
						return `📋 Active plan already exists: ${relativePath}

To continue with existing plan:
  → Use plan_read to review current state
  → Update with plan_save when making progress

To create an additional plan without replacing active:
  → Call plan_save with mode="new" and set_active=false

To switch active plan:
  → Call plan_set_active with plan name from plan_list`;
					}

					return `🎯 Planning Mode Requested: ${args.reason}

To create a structured implementation plan:

1. **Run the /plan command** with your task description:
   /plan "${args.reason}"

2. The plan agent will:
   - Analyze the task complexity
   - Research codebase patterns (if needed)
   - Create a phased implementation plan
   - Save it for cross-session persistence

3. Once the plan is created:
    - Use plan_read to review it
    - Use plan_set_active to switch between plans
    - Use /work to start implementation
    - Update progress with plan_save

💡 Tip: Load skill('plan-protocol') for the full plan format specification.`;
				},
			}),

			plan_exit: tool({
				description:
					"Signal completion of planning phase. Returns instructions for transitioning to implementation mode. Call this after a plan is finalized and ready for execution.",
				args: {
					summary: tool.schema
						.string()
						.optional()
						.describe("Brief summary of the completed plan"),
				},
				async execute(args) {
					const activePlan = await sm.readActivePlanState();

					if (!activePlan) {
						return `⚠️ No active plan found. Nothing to exit from.

To create a plan first:
  → Run /plan "your task description"`;
					}

					const relativePath = relative(directory, activePlan.active_plan);
					const summaryText = args.summary
						? `\n\n**Summary**: ${args.summary}`
						: "";

					return `✅ Planning phase complete!${summaryText}

**Plan**: ${activePlan.plan_name}
**Path**: ${relativePath}

To begin implementation:

1. **Run /work** to start executing the plan
   → This delegates to the build agent with plan context

2. Or manually:
   → Use plan_read to review the plan
   → Work through phases sequentially
   → Mark tasks complete as you go
   → Use notepad_write to record learnings

3. Track progress:
   → Update plan with plan_save after completing tasks
   → Use todowrite for fine-grained task tracking

🚀 Ready to ship!`;
				},
			}),

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

			task_graph_status: tool({
				description:
					"Inspect dependency-aware delegation graph status with blocked-task metadata.",
				args: {
					root_session_id: tool.schema
						.string()
						.optional()
						.describe(
							"Optional root session scope. Defaults to current root session.",
						),
					include_completed: tool.schema
						.boolean()
						.optional()
						.describe("Include terminal nodes (default: true)."),
					limit: tool.schema
						.number()
						.int()
						.min(1)
						.max(500)
						.optional()
						.describe("Maximum delegation records to inspect (default: 200)."),
				},
				async execute(args, toolCtx) {
					if (!hookConfig.features.taskGraph) {
						return "❌ task_graph_status is disabled. Enable features.taskGraph in workspace.json.";
					}

					if (!args.root_session_id && !toolCtx?.sessionID) {
						return "❌ task_graph_status requires sessionID when root_session_id is omitted.";
					}

					const scopeRoot = args.root_session_id
						? args.root_session_id
						: await getRootSessionID(toolCtx?.sessionID);
					const records = await delegationState.listDelegations({
						root_session_id: scopeRoot,
						limit: args.limit ?? 200,
					});
					const graph = buildTaskGraph(records, {
						includeCompleted: args.include_completed ?? true,
					});

					return JSON.stringify(
						{
							root_session_id: scopeRoot,
							...graph,
						},
						null,
						2,
					);
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
						const rootSessionID = await getRootSessionID(sessionID);
						await writeApprovalAudit({
							sessionID: rootSessionID,
							tool: "continuation_continue",
							outcome: "blocked",
							reason: "policy_idempotency_required",
							detail:
								"boundaryPolicyV2 requires idempotency_key for continuation_continue.",
							metadata: {
								session_id: sessionID,
							},
						});
						return "❌ continuation_continue requires idempotency_key when features.boundaryPolicyV2 is enabled.";
					}

					const updated = await continuationState.setSessionMode({
						session_id: sessionID,
						mode: "running",
						idempotency_key: args.idempotency_key,
					});
					if (hookConfig.features.boundaryPolicyV2) {
						const rootSessionID = await getRootSessionID(sessionID);
						await writeApprovalAudit({
							sessionID: rootSessionID,
							tool: "continuation_continue",
							outcome: "approved",
							reason: "policy_transition_applied",
							metadata: {
								session_id: sessionID,
								idempotency_key: Boolean(args.idempotency_key),
								mode: "running",
							},
						});
					}
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
						const rootSessionID = await getRootSessionID(sessionID);
						await writeApprovalAudit({
							sessionID: rootSessionID,
							tool: "continuation_handoff",
							outcome: "blocked",
							reason: "policy_idempotency_required",
							detail:
								"boundaryPolicyV2 requires idempotency_key for continuation_handoff.",
							metadata: {
								session_id: sessionID,
							},
						});
						return "❌ continuation_handoff requires idempotency_key when features.boundaryPolicyV2 is enabled.";
					}

					const updated = await continuationState.setSessionMode({
						session_id: sessionID,
						mode: "handoff",
						handoff_to: args.to.trim(),
						handoff_summary: args.summary.trim(),
						idempotency_key: args.idempotency_key,
					});
					if (hookConfig.features.boundaryPolicyV2) {
						const rootSessionID = await getRootSessionID(sessionID);
						await writeApprovalAudit({
							sessionID: rootSessionID,
							tool: "continuation_handoff",
							outcome: "approved",
							reason: "policy_transition_applied",
							metadata: {
								session_id: sessionID,
								idempotency_key: Boolean(args.idempotency_key),
								mode: "handoff",
							},
						});
					}
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
						const rootSessionID = await getRootSessionID(sessionID);
						await writeApprovalAudit({
							sessionID: rootSessionID,
							tool: "continuation_stop",
							outcome: "blocked",
							reason: "policy_idempotency_required",
							detail:
								"boundaryPolicyV2 requires idempotency_key for continuation_stop.",
							metadata: {
								session_id: sessionID,
							},
						});
						return "❌ continuation_stop requires idempotency_key when features.boundaryPolicyV2 is enabled.";
					}

					const updated = await continuationState.setSessionMode({
						session_id: sessionID,
						mode: "stopped",
						reason: args.reason?.trim(),
						idempotency_key: args.idempotency_key,
					});
					if (hookConfig.features.boundaryPolicyV2) {
						const rootSessionID = await getRootSessionID(sessionID);
						await writeApprovalAudit({
							sessionID: rootSessionID,
							tool: "continuation_stop",
							outcome: "approved",
							reason: "policy_transition_applied",
							metadata: {
								session_id: sessionID,
								idempotency_key: Boolean(args.idempotency_key),
								mode: "stopped",
							},
						});
					}
					markCompactionStateDirty(sessionID);
					return JSON.stringify(updated, null, 2);
				},
			}),

			boundary_policy_status: tool({
				description:
					"Inspect boundary policy posture, gated tool coverage, and audit summaries for the current root session.",
				args: {
					include_audit_summary: tool.schema
						.boolean()
						.optional()
						.describe("Include audit outcome/reason counts (default: true)."),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ boundary_policy_status requires sessionID. This is a system error.";
					}

					const rootSessionID = await getRootSessionID(toolCtx.sessionID);
					const includeAuditSummary = args.include_audit_summary !== false;

					const response: Record<string, unknown> = {
						root_session_id: rootSessionID,
						feature_flags: {
							boundaryPolicyV2: hookConfig.features.boundaryPolicyV2,
							approvalGate: hookConfig.features.approvalGate,
							hashAnchoredEdit: hookConfig.features.hashAnchoredEdit,
							autonomyPolicy: hookConfig.features.autonomyPolicy,
							continuationCommands: hookConfig.features.continuationCommands,
						},
						approval_policy: hookConfig.approval,
						contracts: {
							orchestrator_agents: ["plan", "build"],
							implementer_agents: ["coder", "frontend", "build"],
						},
						gated_paths: {
							approval_gate_tools: hookConfig.approval.tools,
							continuation_idempotency_required_when_boundary_v2: [
								"continuation_continue",
								"continuation_handoff",
								"continuation_stop",
							],
							orchestrator_direct_edit_advisory: ["write", "edit"],
						},
					};

					if (includeAuditSummary) {
						const approvalStore = await approvalState.readStore();
						const audit = approvalStore.audit.filter(
							(entry) => entry.session_id === rootSessionID,
						);

						const byOutcome = audit.reduce<Record<string, number>>(
							(acc, entry) => {
								acc[entry.outcome] = (acc[entry.outcome] ?? 0) + 1;
								return acc;
							},
							{},
						);

						const byReason = audit.reduce<Record<string, number>>(
							(acc, entry) => {
								acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
								return acc;
							},
							{},
						);

						response.audit_summary = {
							total: audit.length,
							by_outcome: byOutcome,
							by_reason: byReason,
						};
					}

					return JSON.stringify(response, null, 2);
				},
			}),

			claude_compat_scan: tool({
				description:
					"Discover Claude-compatible assets across .claude/.agents roots for interoperability.",
				args: {
					include_assets: tool.schema
						.boolean()
						.optional()
						.describe("Include full asset paths in output (default: false)."),
				},
				async execute(args) {
					if (!hookConfig.features.claudeCompatibility) {
						return "❌ claude_compat_scan is disabled. Enable features.claudeCompatibility in workspace.json.";
					}

					const snapshot = await discoverClaudeCompatAssets({
						directory,
						homeDirectory: homedir(),
					});

					if (args.include_assets) {
						return JSON.stringify(snapshot, null, 2);
					}

					return JSON.stringify(
						{
							generated_at: snapshot.generated_at,
							roots: snapshot.roots,
							totals: snapshot.totals,
						},
						null,
						2,
					);
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

			// ── Delegation Tools ───────────────────────────────

			delegate: tool({
				description:
					"Launch an async subagent task and return a citation-ready delegation reference.",
				args: {
					description: tool.schema
						.string()
						.describe("Short 3-5 word delegation description."),
					prompt: tool.schema
						.string()
						.describe("Prompt sent to delegated subagent session."),
					subagent_type: tool.schema
						.string()
						.optional()
						.describe(
							"Optional explicit subagent type. Required unless auto_route/category is provided.",
						),
					category: tool.schema
						.string()
						.optional()
						.describe(
							"Optional routing category: quick|deep|visual|research|review|build|planning|general.",
						),
					auto_route: tool.schema
						.boolean()
						.optional()
						.describe(
							"Enable category-based automatic agent routing (default: false).",
						),
					command: tool.schema
						.string()
						.optional()
						.describe("Optional command context for delegated execution."),
					depends_on: tool.schema
						.array(tool.schema.string())
						.optional()
						.describe(
							"Optional dependency delegation IDs. When provided, this delegation waits until dependencies succeed.",
						),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ delegate requires sessionID. This is a system error.";
					}

					const description = args.description.trim();
					const subagentType = args.subagent_type?.trim() ?? "";
					const prompt = args.prompt.trim();
					const category = args.category?.trim();
					const autoRoute = args.auto_route ?? false;
					const dependencyIDs =
						args.depends_on
							?.map((entry) => entry.trim())
							.filter((entry) => entry.length > 0) ?? [];

					if (!description) {
						return "❌ description is required.";
					}

					if (!prompt) {
						return "❌ prompt is required.";
					}

					if (category && !parseDelegationCategory(category)) {
						return "❌ category must be one of: quick, deep, visual, research, review, build, planning, general.";
					}

					if (!subagentType && !autoRoute && !category) {
						return "❌ Provide subagent_type, or set auto_route/category for delegated routing.";
					}

					if (dependencyIDs.length > 0 && !hookConfig.features.taskGraph) {
						return "❌ Dependency-aware delegation requires features.taskGraph=true in workspace config.";
					}

					const command = args.command?.trim();
					const routingDecision = resolveDelegationRouting({
						description,
						prompt,
						command,
						category,
						subagentType: subagentType || undefined,
						autoRoute,
					});
					const chosenAgent = routingDecision.agent;

					await toolCtx.ask({
						permission: "task",
						patterns: [chosenAgent],
						always: ["*"],
						metadata: {
							description,
							subagent_type: chosenAgent,
							category: routingDecision.telemetry.detected_category,
							auto_route: autoRoute,
						},
					});

					let createdDelegationID: string | null = null;
					let createdChildSessionID: string | null = null;

					try {
						const rootSessionID = await getRootSessionID(toolCtx.sessionID);
						const delegationID = await generateDelegationID();

						for (const dependencyID of dependencyIDs) {
							const dependency =
								await delegationState.getDelegation(dependencyID);
							if (!dependency) {
								return `❌ Delegation dependency '${dependencyID}' was not found.`;
							}

							if (dependency.root_session_id !== rootSessionID) {
								return `❌ Delegation dependency '${dependencyID}' is outside the root session scope.`;
							}
						}

						const childSession = await delegationClient.session.create({
							body: {
								title: `${description} (@${chosenAgent} delegation)`,
								parentID: toolCtx.sessionID,
							},
						});

						const childSessionID = getSessionIDFromCreateResponse(
							childSession.data,
						);
						if (!childSessionID) {
							return "❌ Failed to create delegation session.";
						}
						createdChildSessionID = childSessionID;

						const promptText = command
							? `Command Context:\n${command}\n\nTask:\n${prompt}`
							: prompt;
						const continuationRecord = await continuationState.getSession(
							toolCtx.sessionID,
						);

						const created = await delegationState.createDelegation({
							id: delegationID,
							root_session_id: rootSessionID,
							parent_session_id: toolCtx.sessionID,
							child_session_id: childSessionID,
							agent: chosenAgent,
							prompt: promptText,
							category: routingDecision.telemetry.detected_category,
							routing: routingDecision.telemetry,
							tmux_session_name: continuationRecord?.tmux_session_name,
							tmux_window_name: continuationRecord?.tmux_window_name,
							depends_on: dependencyIDs.length > 0 ? dependencyIDs : undefined,
						});
						createdDelegationID = delegationID;

						if (created.status === "blocked") {
							const blockedBy = await delegationState.getBlockingDependencies(
								created.id,
							);
							markCompactionStateDirty(toolCtx.sessionID);

							return formatDelegationStatusOutput({
								delegation_id: created.id,
								status: created.status,
								agent: created.agent,
								category: created.category,
								routing: created.routing,
								tmux_session_name: created.tmux_session_name,
								tmux_window_name: created.tmux_window_name,
								depends_on: created.depends_on,
								blocked_by: blockedBy,
								child_session_id: created.child_session_id,
								created_at: created.created_at,
								updated_at: created.updated_at,
								started_at: created.started_at,
								completed_at: created.completed_at,
								result: created.result,
								error: created.error,
							});
						}

						await startDelegationSession({
							record: {
								id: created.id,
								child_session_id: created.child_session_id,
								agent: created.agent,
								prompt: created.prompt,
							},
						});

						const running = await delegationState.transitionDelegation(
							delegationID,
							"running",
						);
						markCompactionStateDirty(toolCtx.sessionID);

						return formatDelegationStatusOutput({
							delegation_id: running.id,
							status: running.status,
							agent: running.agent,
							category: running.category,
							routing: running.routing,
							tmux_session_name: running.tmux_session_name,
							tmux_window_name: running.tmux_window_name,
							depends_on: running.depends_on,
							child_session_id: running.child_session_id,
							created_at: running.created_at,
							updated_at: running.updated_at,
							started_at: running.started_at,
							completed_at: running.completed_at,
							result: running.result,
							error: running.error,
						});
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);

						if (!createdDelegationID && createdChildSessionID) {
							try {
								await delegationClient.session.abort({
									path: { id: createdChildSessionID },
								});
							} catch {
								// Best-effort child-session cleanup only.
							}
						}

						if (createdDelegationID) {
							try {
								const failed = await delegationState.transitionDelegation(
									createdDelegationID,
									"failed",
									{
										error: message,
									},
								);
								markCompactionStateDirty(failed.parent_session_id);
							} catch {
								// Best-effort failure transition only.
							}
						}
						return `❌ Failed to start delegation: ${message}`;
					}
				},
			}),

			delegation_read: tool({
				description: "Read persisted delegation status and result by ID.",
				args: {
					delegation_id: tool.schema
						.string()
						.describe("Delegation ID returned by delegate."),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ delegation_read requires sessionID. This is a system error.";
					}

					const rootSessionID = await getRootSessionID(toolCtx.sessionID);
					const record = await delegationState.getDelegation(
						args.delegation_id,
					);
					if (!record) {
						return `❌ Delegation not found: ${args.delegation_id}`;
					}

					if (record.root_session_id !== rootSessionID) {
						return `❌ Delegation ${args.delegation_id} is not in this session scope.`;
					}

					const blockedBy =
						record.status === "blocked"
							? await delegationState.getBlockingDependencies(record.id)
							: undefined;

					return formatDelegationStatusOutput({
						delegation_id: record.id,
						status: record.status,
						agent: record.agent,
						category: record.category,
						routing: record.routing,
						tmux_session_name: record.tmux_session_name,
						tmux_window_name: record.tmux_window_name,
						depends_on: record.depends_on,
						blocked_by: blockedBy,
						child_session_id: record.child_session_id,
						created_at: record.created_at,
						updated_at: record.updated_at,
						started_at: record.started_at,
						completed_at: record.completed_at,
						result: record.result,
						error: record.error,
					});
				},
			}),

			delegation_list: tool({
				description: "List delegations for current root session scope.",
				args: {
					status: tool.schema
						.enum([
							"queued",
							"blocked",
							"running",
							"succeeded",
							"failed",
							"cancelled",
						])
						.optional()
						.describe("Optional status filter."),
					limit: tool.schema
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.describe("Maximum items to return (default: 20)."),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ delegation_list requires sessionID. This is a system error.";
					}

					const limit = args.limit ?? 20;
					const rootSessionID = await getRootSessionID(toolCtx.sessionID);
					const initial = await delegationState.listDelegations({
						root_session_id: rootSessionID,
						status: args.status,
						limit,
					});

					const records = initial;
					const recordsWithBlockers = await Promise.all(
						records.map(async (record) => ({
							...record,
							blocked_by:
								record.status === "blocked"
									? await delegationState.getBlockingDependencies(record.id)
									: undefined,
						})),
					);

					return JSON.stringify(
						{
							root_session_id: rootSessionID,
							count: recordsWithBlockers.length,
							delegations: recordsWithBlockers.map((record) => ({
								id: record.id,
								status: record.status,
								agent: record.agent,
								category: record.category,
								routing: record.routing,
								tmux_session_name: record.tmux_session_name,
								tmux_window_name: record.tmux_window_name,
								depends_on: record.depends_on,
								blocked_by: record.blocked_by,
								reference: `ref:${record.id}`,
								updated_at: record.updated_at,
							})),
						},
						null,
						2,
					);
				},
			}),

			delegation_cancel: tool({
				description:
					"Abort a running/queued/blocked delegation child session and mark it as cancelled.",
				args: {
					delegation_id: tool.schema
						.string()
						.describe("Delegation ID returned by delegate."),
					reason: tool.schema
						.string()
						.optional()
						.describe("Optional cancellation reason for audit trail."),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ delegation_cancel requires sessionID. This is a system error.";
					}

					const approvalBlocked = await enforceApprovalGate({
						toolName: "delegation_cancel",
						toolCtx,
						reason: `Cancel delegation '${args.delegation_id}'.`,
						metadata: {
							delegation_id: args.delegation_id,
						},
					});
					if (approvalBlocked) {
						return approvalBlocked;
					}

					const rootSessionID = await getRootSessionID(toolCtx.sessionID);
					const record = await delegationState.getDelegation(
						args.delegation_id,
					);
					if (!record) {
						return `❌ Delegation not found: ${args.delegation_id}`;
					}

					if (record.root_session_id !== rootSessionID) {
						return `❌ Delegation ${args.delegation_id} is not in this session scope.`;
					}

					if (
						record.status !== "queued" &&
						record.status !== "running" &&
						record.status !== "blocked"
					) {
						return formatDelegationStatusOutput({
							delegation_id: record.id,
							status: record.status,
							agent: record.agent,
							category: record.category,
							routing: record.routing,
							tmux_session_name: record.tmux_session_name,
							tmux_window_name: record.tmux_window_name,
							depends_on: record.depends_on,
							child_session_id: record.child_session_id,
							created_at: record.created_at,
							updated_at: record.updated_at,
							started_at: record.started_at,
							completed_at: record.completed_at,
							result: record.result,
							error: record.error,
						});
					}

					let abortError: string | null = null;
					try {
						await delegationClient.session.abort({
							path: { id: record.child_session_id },
						});
					} catch (error) {
						abortError = error instanceof Error ? error.message : String(error);
					}

					const reason = args.reason?.trim();
					const errorText = [
						reason
							? `Cancelled: ${reason}`
							: "Delegation cancelled by user request.",
						abortError ? `Abort API error: ${abortError}` : null,
					]
						.filter(Boolean)
						.join(" ");

					const cancelled = await delegationState.transitionDelegation(
						record.id,
						"cancelled",
						{ error: errorText },
					);
					markCompactionStateDirty(cancelled.parent_session_id);

					return formatDelegationStatusOutput({
						delegation_id: cancelled.id,
						status: cancelled.status,
						agent: cancelled.agent,
						category: cancelled.category,
						routing: cancelled.routing,
						tmux_session_name: cancelled.tmux_session_name,
						tmux_window_name: cancelled.tmux_window_name,
						depends_on: cancelled.depends_on,
						child_session_id: cancelled.child_session_id,
						created_at: cancelled.created_at,
						updated_at: cancelled.updated_at,
						started_at: cancelled.started_at,
						completed_at: cancelled.completed_at,
						result: cancelled.result,
						error: cancelled.error,
					});
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
