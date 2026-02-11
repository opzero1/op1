/**
 * Tool Output Safety Hooks
 *
 * Handles output truncation, edit error recovery, empty task detection,
 * and anti-polling reminders for background tasks.
 *
 * Supports two modes:
 * - Static truncation (default): MAX_OUTPUT_CHARS / MAX_OUTPUT_LINES
 * - Dynamic truncation: Context-window-aware, uses session token usage
 */

// ==========================================
// TYPES
// ==========================================

/**
 * Minimal client interface for fetching session messages.
 * We use `unknown` for the result and validate at runtime
 * to avoid coupling to generated SDK types.
 */
export interface TokenAwareClient {
	session: {
		messages: (opts: {
			path: { id: string };
			query?: { limit?: number };
		}) => Promise<{ data?: unknown }>;
	};
}

/**
 * Context window usage information
 */
interface ContextWindowUsage {
	usedTokens: number;
	remainingTokens: number;
	usageRatio: number;
}

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
	"webfetch",
	"WebFetch",
	"search_semantic",
	"smart_query",
] as const;

/**
 * Static truncation limits (fallback when dynamic is unavailable)
 */
const MAX_OUTPUT_CHARS = 100_000;
const MAX_OUTPUT_LINES = 2000;

/**
 * Dynamic truncation constants
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_CONTEXT_LIMIT = 200_000; // tokens — conservative default
const DYNAMIC_HEADROOM_RATIO = 0.5; // Use at most 50% of remaining headroom
const DEFAULT_MAX_OUTPUT_TOKENS = 50_000; // Static cap for dynamic mode
const PRESERVE_HEADER_LINES = 3; // Keep first N lines (often contain headers)

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
// DYNAMIC TRUNCATION
// ==========================================

/**
 * Estimate token count from text length.
 * Uses the standard ~4 chars per token heuristic.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Get context window usage for a session.
 * Returns null if usage cannot be determined.
 *
 * Uses session.messages() to fetch message list, then sums tokens
 * from assistant messages (user messages have no token info).
 */
async function getContextWindowUsage(
	client: TokenAwareClient,
	sessionID: string,
	contextLimit: number,
): Promise<ContextWindowUsage | null> {
	try {
		const result = await client.session.messages({
			path: { id: sessionID },
		});

		// Runtime validate — SDK returns { data?: unknown }
		const data = result.data;
		if (!data || !Array.isArray(data) || data.length === 0) return null;

		let usedTokens = 0;
		for (const entry of data) {
			const info = (entry as { info?: { role?: string; tokens?: { input?: number; output?: number } } }).info;
			if (info?.role === "assistant" && info.tokens) {
				usedTokens += info.tokens.input ?? 0;
				usedTokens += info.tokens.output ?? 0;
			}
		}

		const remainingTokens = Math.max(0, contextLimit - usedTokens);
		const usageRatio = usedTokens / contextLimit;

		return { usedTokens, remainingTokens, usageRatio };
	} catch {
		return null;
	}
}

/**
 * Calculate the dynamic maximum output size in characters,
 * based on remaining context window headroom.
 */
function calculateDynamicLimit(usage: ContextWindowUsage): number {
	const maxOutputTokens = Math.min(
		usage.remainingTokens * DYNAMIC_HEADROOM_RATIO,
		DEFAULT_MAX_OUTPUT_TOKENS,
	);
	return Math.max(1000, Math.floor(maxOutputTokens * CHARS_PER_TOKEN_ESTIMATE));
}

// ==========================================
// STATIC TRUNCATION
// ==========================================

/**
 * Truncate output using static limits (line count + char count).
 * Preserves first PRESERVE_HEADER_LINES lines when truncating.
 */
function truncateStatic(output: string): {
	result: string;
	truncated: boolean;
} {
	if (typeof output !== "string") {
		return { result: String(output ?? ""), truncated: false };
	}

	const lines = output.split("\n");

	// Check line count
	if (lines.length > MAX_OUTPUT_LINES) {
		const kept = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
		return {
			result: `${kept}\n\n... [OUTPUT TRUNCATED: ${lines.length - MAX_OUTPUT_LINES} more lines. Use grep with specific patterns to narrow results.]`,
			truncated: true,
		};
	}

	// Check character count
	if (output.length > MAX_OUTPUT_CHARS) {
		const kept = output.slice(0, MAX_OUTPUT_CHARS);
		return {
			result: `${kept}\n\n... [OUTPUT TRUNCATED: ${output.length - MAX_OUTPUT_CHARS} more characters. Use more specific search patterns.]`,
			truncated: true,
		};
	}

	return { result: output, truncated: false };
}

/**
 * Truncate output using dynamic context-window-aware limits.
 * Preserves first lines as headers and truncates the middle.
 */
function truncateDynamic(
	output: string,
	maxChars: number,
): { result: string; truncated: boolean } {
	if (typeof output !== "string") {
		return { result: String(output ?? ""), truncated: false };
	}

	if (output.length <= maxChars) {
		return { result: output, truncated: false };
	}

	const lines = output.split("\n");

	// Preserve header lines
	const headerLines = lines.slice(0, PRESERVE_HEADER_LINES);
	const headerText = headerLines.join("\n");

	// Budget remaining characters for body
	const bodyBudget = maxChars - headerText.length - 200; // 200 for truncation message
	if (bodyBudget <= 0) {
		return {
			result: `${headerText}\n\n... [OUTPUT TRUNCATED: Content exceeded dynamic limit of ${maxChars} chars based on context window usage. Use more specific patterns.]`,
			truncated: true,
		};
	}

	const bodyLines = lines.slice(PRESERVE_HEADER_LINES);
	const bodyText = bodyLines.join("\n");

	if (bodyText.length <= bodyBudget) {
		return { result: output, truncated: false };
	}

	const keptBody = bodyText.slice(0, bodyBudget);
	const droppedChars = bodyText.length - bodyBudget;
	const droppedTokensEst = estimateTokens(bodyText) - estimateTokens(keptBody);

	return {
		result: `${headerText}\n${keptBody}\n\n... [DYNAMICALLY TRUNCATED: ~${droppedTokensEst} tokens (~${droppedChars} chars) removed to preserve context window headroom. Use more specific search patterns.]`,
		truncated: true,
	};
}

// ==========================================
// HELPERS
// ==========================================

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
// HOOK HANDLERS
// ==========================================

/**
 * Process tool output for safety: truncation, error recovery, empty detection.
 * Uses static truncation limits.
 */
export function handleToolOutputSafety(
	input: { tool: string; args?: unknown },
	output: { output?: string },
): void {
	if (typeof output.output !== "string") return;

	// 1. Tool Output Truncation (static)
	if (
		TRUNCATABLE_TOOLS.includes(
			input.tool as (typeof TRUNCATABLE_TOOLS)[number],
		)
	) {
		const { result, truncated } = truncateStatic(output.output);
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

/**
 * Process tool output with dynamic, context-window-aware truncation.
 * Falls back to static truncation if session usage can't be determined.
 */
export async function handleToolOutputSafetyDynamic(
	input: { tool: string; sessionID: string; args?: unknown },
	output: { output?: string },
	client: TokenAwareClient,
	contextLimit = DEFAULT_CONTEXT_LIMIT,
): Promise<void> {
	if (typeof output.output !== "string") return;

	// 1. Dynamic Tool Output Truncation
	if (
		TRUNCATABLE_TOOLS.includes(
			input.tool as (typeof TRUNCATABLE_TOOLS)[number],
		)
	) {
		const usage = await getContextWindowUsage(
			client,
			input.sessionID,
			contextLimit,
		);

		if (usage) {
			const dynamicLimit = calculateDynamicLimit(usage);
			const { result, truncated } = truncateDynamic(
				output.output,
				dynamicLimit,
			);
			if (truncated) {
				output.output = result;
			}
		} else {
			// Fallback to static truncation
			const { result, truncated } = truncateStatic(output.output);
			if (truncated) {
				output.output = result;
			}
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

// Re-export for dynamic truncation configuration
export {
	DEFAULT_CONTEXT_LIMIT,
	CHARS_PER_TOKEN_ESTIMATE,
	DEFAULT_MAX_OUTPUT_TOKENS,
	DYNAMIC_HEADROOM_RATIO,
};
