/**
 * Verification Enforcement Hook
 *
 * After implementer agent tasks complete, injects a verification reminder
 * to force the orchestrator to verify changes before marking tasks done.
 */

import { getGitDiffStats } from "../utils.js";

/**
 * Agents that write code and require verification after completion
 */
const IMPLEMENTER_AGENTS = ["coder", "frontend", "build"] as const;

const DEFAULT_AUTOPILOT_THROTTLE_MS = 45_000;
const reminderState = new Map<
	string,
	{ lastReminderAt: number; lastCallID?: string }
>();

interface VerificationOptions {
	enabled?: boolean;
	throttleMs?: number;
}

function isAutopilotEnabled(options?: VerificationOptions): boolean {
	if (typeof options?.enabled === "boolean") {
		return options.enabled;
	}

	const raw = Bun.env.OP7_VERIFICATION_AUTOPILOT;
	if (!raw) return true;

	const normalized = raw.trim().toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function getAutopilotThrottleMs(options?: VerificationOptions): number {
	if (typeof options?.throttleMs === "number") {
		return Math.max(0, Math.floor(options.throttleMs));
	}

	const raw = Bun.env.OP7_VERIFICATION_AUTOPILOT_THROTTLE_MS;
	if (!raw) return DEFAULT_AUTOPILOT_THROTTLE_MS;

	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return DEFAULT_AUTOPILOT_THROTTLE_MS;
	}

	return parsed;
}

function shouldInjectReminder(
	sessionID: string | undefined,
	callID: string | undefined,
	now: number,
	options?: VerificationOptions,
): boolean {
	if (!sessionID) return true;

	const previous = reminderState.get(sessionID);
	if (!previous) return true;

	if (callID && previous.lastCallID === callID) {
		return false;
	}

	return now - previous.lastReminderAt >= getAutopilotThrottleMs(options);
}

function markReminder(
	sessionID: string | undefined,
	callID: string | undefined,
	now: number,
): void {
	if (!sessionID) return;
	reminderState.set(sessionID, {
		lastReminderAt: now,
		lastCallID: callID,
	});
}

/**
 * Build the verification reminder that gets injected after implementer tasks
 */
function buildVerificationReminder(
	agentType: string,
	fileChanges: string,
): string {
	return `
<system-reminder>
⚠️ MANDATORY VERIFICATION PROTOCOL
${agentType} task completed. Verify before marking complete.

**READ**
- Run \`plan_read\` and \`notepad_read\`.
- Review changed files:

${fileChanges}

**AUTOMATED CHECKS**
1. Run \`lsp_diagnostics\` on changed files.
2. Run relevant tests.
3. Run build and typecheck.

**MANUAL QA**
- Confirm expected behavior and edge cases.
- Check for regressions.

**GATE DECISION**
- PASS: update plan with \`plan_save\`, write learnings, continue.
- FAIL: do not mark complete; fix and rerun checks.
</system-reminder>`;
}

/**
 * Check if a task completion is from an implementer agent and inject verification.
 * Only applies to `task` tool outputs.
 */
export async function handleVerification(
	input: { tool: string; sessionID?: string; callID?: string; args?: unknown },
	output: { output?: string },
	directory: string,
	options?: VerificationOptions,
): Promise<void> {
	if (!isAutopilotEnabled(options)) return;
	if (input.tool.toLowerCase() !== "task") return;
	if (typeof output.output !== "string") return;

	const args = input.args as { subagent_type?: string } | undefined;
	const agentType = args?.subagent_type;

	if (
		agentType &&
		IMPLEMENTER_AGENTS.includes(
			agentType as (typeof IMPLEMENTER_AGENTS)[number],
		)
	) {
		const now = Date.now();
		if (!shouldInjectReminder(input.sessionID, input.callID, now, options)) {
			return;
		}

		const fileChanges = await getGitDiffStats(directory);
		const reminder = buildVerificationReminder(agentType, fileChanges);
		output.output = output.output + reminder;
		markReminder(input.sessionID, input.callID, now);
	}
}
