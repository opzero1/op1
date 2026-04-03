/**
 * Autonomy Policy Hook
 *
 * Reinforces two execution guarantees:
 * 1. Continue automatically (avoid "I can continue" prompts).
 * 2. Run internal decision rounds before escalating to the human.
 */

const MIN_DECISION_ROUNDS = 3;
const DECISION_ROUND_TTL_MS = 5 * 60_000;

const CONTINUE_QUESTION_REGEX =
	/\b(i can continue|i can keep going|would you like me to continue|would you like me to proceed|should i continue|should i proceed|shall i continue|shall i proceed|do you want me to continue|do you want me to proceed|want me to continue|want me to proceed|want me to keep going|let me know if you want me to continue|let me know if you'd like me to continue)\b/i;

const USER_DECISION_REGEX =
	/\b(i need your decision|i need your input|please choose|which option do you prefer|i need clarification from you|i need user input|ask the user|waiting for user decision)\b/i;

const AUTONOMOUS_RECOVERY_REGEX =
	/\b(state file missing|awaiting user confirmation|user confirmation required|continue with .*context only|restore from backup|create new state|fresh start|options:\s*[a-z]\)|which option should we choose)\b/i;

interface DecisionState {
	rounds: number;
	updated_at: number;
}

const decisionRounds = new Map<string, DecisionState>();

function getDecisionRounds(sessionID: string, now: number): number {
	const state = decisionRounds.get(sessionID);
	if (!state) return 0;

	if (now - state.updated_at > DECISION_ROUND_TTL_MS) {
		decisionRounds.delete(sessionID);
		return 0;
	}

	return state.rounds;
}

function setDecisionRounds(
	sessionID: string,
	rounds: number,
	now: number,
): void {
	decisionRounds.set(sessionID, {
		rounds,
		updated_at: now,
	});
}

function isDecisionRoundCall(args: unknown): boolean {
	if (!args || typeof args !== "object") return false;

	const payload = args as Record<string, unknown>;
	const subagentType =
		typeof payload.subagent_type === "string"
			? payload.subagent_type.toLowerCase()
			: "";

	const prompt =
		typeof payload.prompt === "string" ? payload.prompt.toLowerCase() : "";

	if (subagentType === "oracle") return true;
	if (prompt.includes("brainstorm")) return true;

	return false;
}

function buildAutoContinueReminder(): string {
	return `\n<system-reminder>
⚙️ AUTO-CONTINUE POLICY

Do not ask "should I continue".
Continue execution automatically through the next unchecked plan task.
Only ask the user when a true blocker remains after required decision rounds.
</system-reminder>`;
}

function buildDecisionRoundReminder(roundsCompleted: number): string {
	const remaining = Math.max(0, MIN_DECISION_ROUNDS - roundsCompleted);
	return `\n<system-reminder>
🧠 DECISION PROTOCOL ENFORCEMENT

Before asking the user for a decision, run at least ${MIN_DECISION_ROUNDS} internal rounds:
1) oracle consultation
2) brainstorming pass
3) oracle/brainstorm synthesis

Rounds completed so far: ${roundsCompleted}
Remaining before user escalation: ${remaining}

Proceed with internal rounds now. Do not escalate yet.
</system-reminder>`;
}

function buildAutonomousRecoveryReminder(): string {
	return `\n<system-reminder>
♻️ AUTONOMOUS RECOVERY POLICY

This workflow is expected to continue without asking the user to choose from recovery options.
If the available paths are safe and reversible, pick the safest recovery path yourself, record the choice, and keep going.
For explicit long-running loops, auto-recovery is the default. Continue until the user explicitly stops the loop.
Only stop for an explicit user stop instruction, a real destructive or irreversible decision, a missing credential, or an explicit continuation stop or handoff.
</system-reminder>`;
}

export function createAutonomyPolicyHook() {
	return async (
		input: { tool: string; sessionID: string; args?: unknown },
		output: { output?: string },
	): Promise<void> => {
		const now = Date.now();
		const isTask = input.tool.toLowerCase() === "task";
		const isDecisionRound = isTask && isDecisionRoundCall(input.args);

		if (isDecisionRound) {
			const next = getDecisionRounds(input.sessionID, now) + 1;
			setDecisionRounds(input.sessionID, next, now);
		} else {
			// Expire stale decision cycles on regular task traffic.
			getDecisionRounds(input.sessionID, now);
		}

		if (typeof output.output !== "string") return;

		if (output.output.includes("<done>COMPLETE</done>")) {
			decisionRounds.delete(input.sessionID);
			return;
		}

		if (CONTINUE_QUESTION_REGEX.test(output.output)) {
			output.output += buildAutoContinueReminder();
		}

		if (AUTONOMOUS_RECOVERY_REGEX.test(output.output)) {
			output.output += buildAutonomousRecoveryReminder();
			return;
		}

		if (USER_DECISION_REGEX.test(output.output)) {
			const rounds = getDecisionRounds(input.sessionID, now);
			if (rounds < MIN_DECISION_ROUNDS) {
				output.output += buildDecisionRoundReminder(rounds);
			} else {
				setDecisionRounds(input.sessionID, 0, now);
			}
		}
	};
}
