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

import { stat } from "fs/promises";
import { join, relative } from "path";
import { homedir } from "os";
import { type Plugin, tool } from "@opencode-ai/plugin";

// ── Modules ────────────────────────────────────────────────
import { createSafeRuntimeHook, resolveHookConfig, type HookConfig } from "./hooks/safe-hook.js";
import { handleToolOutputSafetyDynamic } from "./hooks/tool-output-safety.js";
import { handleVerification } from "./hooks/verification.js";
import { createShellEnvHook } from "./hooks/shell-env.js";
import { createCompactionHook, type CompactionDeps } from "./hooks/compaction.js";
import { createToolExecuteBeforeHook } from "./hooks/non-interactive-guard.js";
import { checkPreemptiveCompaction, type CompactionClient } from "./hooks/preemptive-compaction.js";

import {
	extractMarkdownParts,
	parsePlanMarkdown,
	formatParseError,
} from "./plan/schema.js";
import {
	autoUpdatePlanStatus,
	calculatePlanStatus,
} from "./plan/status.js";
import {
	createStateManager,
	generatePlanMetadata,
	generatePlanPath,
	getPlanName,
	NOTEPAD_FILES,
	type ActivePlanState,
	type NotepadFile,
} from "./plan/state.js";
import { getProjectId, formatGitStats, isSystemError } from "./utils.js";

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
	const sm = createStateManager(workspaceDir, plansDir, notepadsDir, activePlanPath);

	// Hook configuration (future: read from plugin config)
	const hookConfig: HookConfig = resolveHookConfig();

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

	// ── Hook factories ─────────────────────────────────────

	const toolExecuteBeforeHook = createSafeRuntimeHook(
		"tool.execute.before",
		() => createToolExecuteBeforeHook(),
		hookConfig,
	);

	const toolExecuteAfterHook = createSafeRuntimeHook(
		"tool.execute.after",
		() =>
			async (
				input: { tool: string; sessionID: string; callID: string; args?: unknown },
				output: { title: string; output: string; metadata: unknown },
			) => {
				// Dynamic context-window-aware truncation (falls back to static)
				await handleToolOutputSafetyDynamic(input, output, ctx.client);

				// Async: verification reminders after implementer agent tasks
				await handleVerification(input, output, directory);

				// Preemptive compaction at 78% token usage
				await checkPreemptiveCompaction(
					ctx.client as unknown as CompactionClient,
					input.sessionID,
					directory,
				);
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
	};

	const compactionHook = createSafeRuntimeHook(
		"experimental.session.compacting",
		() => createCompactionHook(compactionDeps),
		hookConfig,
	);

	// ── Build hook map (only include non-null hooks) ───────

	const hook: Record<string, unknown> = {};
	if (toolExecuteBeforeHook) hook["tool.execute.before"] = toolExecuteBeforeHook;
	if (toolExecuteAfterHook) hook["tool.execute.after"] = toolExecuteAfterHook;
	if (shellEnvHook) hook["shell.env"] = shellEnvHook;
	if (compactionHook) hook["experimental.session.compacting"] = compactionHook;

	// ── Return plugin ──────────────────────────────────────

	return {
		tool: {
			plan_save: tool({
				description:
					"Save the implementation plan as markdown. Must include citations (ref:delegation-id) for decisions based on research. Plan is validated before saving.",
				args: {
					content: tool.schema
						.string()
						.describe("The full plan in markdown format"),
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

					const existingState = await sm.readActivePlanState();
					let planPath: string;
					let isNewPlan = false;

					if (existingState) {
						planPath = existingState.active_plan;

						if (!existingState.session_ids.includes(toolCtx.sessionID)) {
							existingState.session_ids.push(toolCtx.sessionID);
							await sm.writeActivePlanState(existingState);
						}
					} else {
						const { mkdir } = await import("fs/promises");
						await mkdir(plansDir, { recursive: true });
						planPath = generatePlanPath(plansDir);
						isNewPlan = true;

						// Generate metadata for new plans
						const metadata = await generatePlanMetadata(
							ctx.client,
							args.content,
							toolCtx.sessionID,
						);

						const state: ActivePlanState = {
							active_plan: planPath,
							started_at: new Date().toISOString(),
							session_ids: [toolCtx.sessionID],
							plan_name: getPlanName(planPath),
							title: metadata.title,
							description: metadata.description,
						};
						await sm.writeActivePlanState(state);
					}

					await Bun.write(planPath, autoUpdatedContent);

					const warningCount = result.warnings?.length ?? 0;
					const calculatedStatus = calculatePlanStatus(result.data.phases);
					const statusNote = calculatedStatus === "complete"
						? " ✅ Plan marked complete (all tasks done)."
						: "";
					const warningText =
						warningCount > 0
							? ` (${warningCount} warnings: ${result.warnings?.join(", ")})`
							: "";

					const relativePath = relative(directory, planPath);
					const action = isNewPlan ? "created" : "updated";

					return `Plan ${action} at ${relativePath}.${statusNote}${warningText}`;
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
					const activePlan = await sm.readActivePlanState();
					if (activePlan) {
						await sm.appendSessionToActivePlan(toolCtx.sessionID);

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

					const activePlan = await sm.readActivePlanState();
					const allPlans = await sm.listPlans();

					if (allPlans.length === 0) {
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

					const otherPlans = allPlans.filter(
						(p) => p !== activePlan?.active_plan,
					);
					if (otherPlans.length > 0) {
						planList.push(`## Other Plans (${otherPlans.length})`);
						for (const planPath of otherPlans) {
							const stats = await stat(planPath);
							const name = getPlanName(planPath);
							const relativePath = relative(directory, planPath);
							planList.push(
								`- **${name}**: ${relativePath} (modified: ${stats.mtime.toISOString()})`,
							);
						}
					}

					return planList.join("\n");
				},
			}),

			// ── Mode Transition Tools ──────────────────────────

			plan_enter: tool({
				description:
					"Signal intent to enter planning mode. Returns instructions for creating a structured implementation plan. Use when a task is complex and requires upfront planning before implementation.",
				args: {
					reason: tool.schema
						.string()
						.describe("Why planning mode is needed (e.g., 'complex multi-step feature', 'architectural decision')"),
				},
				async execute(args) {
					const activePlan = await sm.readActivePlanState();

					if (activePlan) {
						const relativePath = relative(directory, activePlan.active_plan);
						return `📋 Active plan already exists: ${relativePath}

To continue with existing plan:
  → Use plan_read to review current state
  → Update with plan_save when making progress

To start fresh:
  → Complete or archive the current plan first
  → Then run /plan "your new task"`;
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
					const summaryText = args.summary ? `\n\n**Summary**: ${args.summary}` : "";

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
						const relativePath = relative(directory, notepadDir!);
						return `✅ Appended to ${relativePath}/${args.file}.md`;
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`;
						}
						throw error;
					}
				},
			}),

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
							const stats = await stat(filePath);
							const content = await bunFile.text();
							const lineCount = content.split("\n").length;
							results.push(
								`- **${file}**: ${lineCount} lines, ${stats.size} bytes`,
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

		hook,
	};
};

// ── Test Exports (backward compatibility) ──────────────────
export { extractMarkdownParts, parsePlanMarkdown } from "./plan/schema.js";
export { formatGitStats } from "./utils.js";
