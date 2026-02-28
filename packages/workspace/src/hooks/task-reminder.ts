/**
 * Task Reminder Babysitter Hook
 *
 * Tracks how many tool executions pass without the agent using any
 * plan/notepad tools. After a configurable threshold (default: 20),
 * appends a reminder to record progress.
 *
 * Resets whenever the agent uses plan_save, plan_read, plan_list,
 * notepad_write, notepad_read, notepad_list, or todowrite.
 */

const DEFAULT_THRESHOLD = 20;

/** Tools that reset the turn counter */
const PLAN_TOOLS = new Set([
	"plan_save",
	"plan_read",
	"plan_list",
	"plan_set_active",
	"plan_enter",
	"plan_exit",
	"plan_doc_link",
	"plan_doc_list",
	"plan_doc_load",
	"notepad_read",
	"notepad_write",
	"notepad_list",
	"todowrite",
]);

/** Per-session turn counter */
const sessionTurns = new Map<string, number>();

/**
 * Build the reminder message.
 */
function buildReminderMessage(turnCount: number): string {
	return `\n<system-reminder>📋 Progress check: ${turnCount} tool calls since plan/notepad use. Run plan_save, notepad_write, or todowrite to persist progress.</system-reminder>`;
}

/**
 * Create the task reminder hook.
 * Attaches to `tool.execute.after`.
 */
export function createTaskReminderHook(threshold: number = DEFAULT_THRESHOLD) {
	return async (
		input: { tool: string; sessionID: string },
		output: { output?: string },
	): Promise<void> => {
		const toolName = input.tool.toLowerCase();
		const key = input.sessionID;

		// Reset counter on plan/notepad tool usage
		if (PLAN_TOOLS.has(toolName)) {
			sessionTurns.delete(key);
			return;
		}

		const current = (sessionTurns.get(key) ?? 0) + 1;
		sessionTurns.set(key, current);

		// At threshold, append reminder (then reset to avoid spamming every call)
		if (current >= threshold) {
			if (typeof output.output === "string") {
				output.output = output.output + buildReminderMessage(current);
			}
			// Reset so reminder fires again after another N turns
			sessionTurns.set(key, 0);
		}
	};
}
