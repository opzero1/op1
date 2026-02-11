/**
 * Session Compaction Hook — Plan Context Recovery
 *
 * Registered for the `experimental.session.compacting` hook point.
 * When the session is compacted (summarized), this hook injects:
 * - The active plan content with ← CURRENT marker
 * - Recent notepad entries (learnings, decisions, issues)
 * - Resume instructions for the agent
 *
 * This prevents the agent from "forgetting" the plan during compaction.
 */

import { join } from "path";
import type { ActivePlanState, NotepadFile } from "../plan/state.js";

// ==========================================
// CONSTANTS
// ==========================================

/**
 * Notepad files to include in compaction context (most important first)
 */
const COMPACTION_NOTEPAD_FILES: NotepadFile[] = [
	"decisions.md",
	"learnings.md",
	"issues.md",
];

/**
 * Maximum chars to include from each notepad file.
 * We want to be concise during compaction — only recent entries matter.
 */
const MAX_NOTEPAD_CHARS = 2000;

/**
 * Regex to find the ← CURRENT marker in a plan
 */
const CURRENT_MARKER_REGEX = /^.*←\s*CURRENT.*$/m;

// ==========================================
// TYPES
// ==========================================

/**
 * Dependencies injected into the compaction hook.
 * Avoids coupling to concrete state manager implementation.
 */
export interface CompactionDeps {
	readActivePlanState: () => Promise<ActivePlanState | null>;
	getNotepadDir: () => Promise<string | null>;
	readNotepadFile: (file: NotepadFile) => Promise<string | null>;
}

// ==========================================
// IMPLEMENTATION
// ==========================================

/**
 * Extract the current task from a plan by finding the ← CURRENT marker.
 */
function findCurrentTask(planContent: string): string | null {
	const match = planContent.match(CURRENT_MARKER_REGEX);
	return match ? match[0].trim() : null;
}

/**
 * Get the tail of a notepad file (most recent entries).
 */
function getTail(content: string, maxChars: number): string {
	if (content.length <= maxChars) return content;
	const truncated = content.slice(-maxChars);
	// Find the first newline to avoid starting mid-line
	const firstNewline = truncated.indexOf("\n");
	if (firstNewline > 0 && firstNewline < 200) {
		return `...\n${truncated.slice(firstNewline + 1)}`;
	}
	return `...\n${truncated}`;
}

/**
 * Build the compaction context string with plan and notepad data.
 */
async function buildCompactionContext(
	deps: CompactionDeps,
): Promise<string | null> {
	const activePlan = await deps.readActivePlanState();
	if (!activePlan) return null;

	// Read the plan file
	let planContent: string;
	try {
		const planFile = Bun.file(activePlan.active_plan);
		if (!(await planFile.exists())) return null;
		planContent = await planFile.text();
	} catch {
		return null;
	}

	const currentTask = findCurrentTask(planContent);
	const parts: string[] = [];

	parts.push("<workspace-context>");
	parts.push("## Active Implementation Plan");
	parts.push(`**Name**: ${activePlan.plan_name}`);
	if (activePlan.title) parts.push(`**Title**: ${activePlan.title}`);
	parts.push("");
	parts.push(planContent);
	parts.push("");

	// Resume point
	parts.push("## Resume Point");
	if (currentTask) {
		parts.push(`Current task: ${currentTask}`);
	} else {
		parts.push("No task marked as ← CURRENT. Check the plan for next unchecked task.");
	}
	parts.push("");

	// Notepad entries
	const notepadDir = await deps.getNotepadDir();
	if (notepadDir) {
		const notepadParts: string[] = [];
		for (const file of COMPACTION_NOTEPAD_FILES) {
			const content = await deps.readNotepadFile(file);
			if (content && content.trim().length > 0) {
				const tail = getTail(content.trim(), MAX_NOTEPAD_CHARS);
				notepadParts.push(`### ${file.replace(".md", "")}\n${tail}`);
			}
		}
		if (notepadParts.length > 0) {
			parts.push("## Recent Notepad Entries");
			parts.push(notepadParts.join("\n\n"));
			parts.push("");
		}
	}

	parts.push("## Instructions");
	parts.push("- Read the plan above to understand current progress");
	parts.push("- Continue from the Resume Point");
	parts.push("- Use plan_read for the latest version (plan may have been updated)");
	parts.push("- Use notepad_read for full accumulated wisdom");
	parts.push("</workspace-context>");

	return parts.join("\n");
}

/**
 * Create the experimental.session.compacting hook handler.
 * Injects active plan and notepad context into the compaction summary.
 */
export function createCompactionHook(
	deps: CompactionDeps,
): (
	input: { sessionID: string },
	output: { context: string[]; prompt?: string },
) => Promise<void> {
	return async (_input, output) => {
		const context = await buildCompactionContext(deps);
		if (context) {
			output.context.push(context);
		}
	};
}
