/**
 * Tool Output Safety Hooks
 *
 * Handles output truncation, edit error recovery, empty task detection,
 * and anti-polling reminders for background tasks.
 */

// ==========================================
// CONSTANTS
// ==========================================

/**
 * Tools that can produce large outputs that may need truncation
 */
const TRUNCATABLE_TOOLS = [
	"grep",
	"Grep",
	"glob",
	"Glob",
	"read",
	"Read",
	"bash",
	"Bash",
] as const;

/**
 * Maximum output size before truncation (characters)
 * ~50k tokens = ~200k chars, but we're more conservative
 */
const MAX_OUTPUT_CHARS = 100_000;
const MAX_OUTPUT_LINES = 2000;

/**
 * Edit tool error patterns that indicate AI mistakes
 */
const EDIT_ERROR_PATTERNS = [
	"oldString and newString must be different",
	"oldString not found",
	"oldString found multiple times",
	"requires more code context",
] as const;

const EDIT_ERROR_REMINDER = `
<system-reminder>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ EDIT ERROR - IMMEDIATE ACTION REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You made an Edit mistake. STOP and do this NOW:

1. **READ the file** immediately to see its ACTUAL current state
2. **VERIFY** what the content really looks like (your assumption was wrong)
3. **CONTINUE** with corrected action based on the real file content

DO NOT attempt another edit until you've read and verified the file state.
</system-reminder>`;

const EMPTY_TASK_WARNING = `
<system-reminder>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ EMPTY TASK RESPONSE DETECTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The task completed but returned no response. This indicates:
- The agent failed to execute properly
- The agent did not terminate correctly
- The agent returned an empty result

**ACTION:** Re-delegate the task with more specific instructions,
or investigate what went wrong before proceeding.
</system-reminder>`;

const ANTI_POLLING_REMINDER = `
<system-reminder>
⏳ Background task(s) running. You WILL be notified when complete.
❌ Do NOT poll or check status - continue productive work on other tasks.
</system-reminder>`;

// ==========================================
// HELPERS
// ==========================================

/**
 * Truncate large tool output to prevent context overflow
 */
function truncateOutput(output: string): { result: string; truncated: boolean } {
	// Guard against non-string input
	if (typeof output !== "string") {
		return { result: String(output ?? ""), truncated: false };
	}
	const lines = output.split("\n");
	
	// Check line count
	if (lines.length > MAX_OUTPUT_LINES) {
		const truncated = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
		return {
			result: `${truncated}\n\n... [OUTPUT TRUNCATED: ${lines.length - MAX_OUTPUT_LINES} more lines. Use grep with specific patterns to narrow results.]`,
			truncated: true,
		};
	}
	
	// Check character count
	if (output.length > MAX_OUTPUT_CHARS) {
		const truncated = output.slice(0, MAX_OUTPUT_CHARS);
		return {
			result: `${truncated}\n\n... [OUTPUT TRUNCATED: ${output.length - MAX_OUTPUT_CHARS} more characters. Use more specific search patterns.]`,
			truncated: true,
		};
	}
	
	return { result: output, truncated: false };
}

/**
 * Check if output contains Edit error patterns
 */
function hasEditError(output: string): boolean {
	if (typeof output !== "string") return false;
	const lowerOutput = output.toLowerCase();
	return EDIT_ERROR_PATTERNS.some((pattern) =>
		lowerOutput.includes(pattern.toLowerCase()),
	);
}

/**
 * Check if task response is empty or meaningless
 */
function isEmptyTaskResponse(output: string): boolean {
	const trimmed = output?.trim() ?? "";
	return trimmed === "" || trimmed === "undefined" || trimmed === "null";
}

// ==========================================
// HOOK HANDLER
// ==========================================

/**
 * Process tool output for safety: truncation, error recovery, empty detection.
 * Returns true if the output was modified, false otherwise.
 */
export function handleToolOutputSafety(
	input: { tool: string; args?: unknown },
	output: { output?: string },
): void {
	if (typeof output.output !== "string") return;

	// 1. Tool Output Truncation
	if (
		TRUNCATABLE_TOOLS.includes(
			input.tool as (typeof TRUNCATABLE_TOOLS)[number],
		)
	) {
		const { result, truncated } = truncateOutput(output.output);
		if (truncated) {
			output.output = result;
		}
	}

	// 2. Edit Error Recovery
	if (input.tool.toLowerCase() === "edit") {
		if (hasEditError(output.output)) {
			output.output += EDIT_ERROR_REMINDER;
		}
	}

	// 3. Empty Task Response Detector
	if (input.tool.toLowerCase() === "task") {
		if (isEmptyTaskResponse(output.output)) {
			output.output = EMPTY_TASK_WARNING;
		}

		// 4. Anti-Polling Reminder for Background Tasks
		const taskArgs = input.args as { background?: boolean } | undefined;
		if (taskArgs?.background) {
			output.output = output.output + ANTI_POLLING_REMINDER;
		}
	}
}
