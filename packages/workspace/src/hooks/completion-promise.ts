/**
 * Completion Promise Hook
 *
 * Tracks iteration count per session during momentum continuation.
 * If the agent hasn't emitted a `<done>COMPLETE</done>` tag within
 * maxIterations, appends a demand for explicit completion confirmation.
 *
 * Works in tandem with the momentum hook — momentum pushes forward,
 * completion promise guards against infinite loops.
 */

const DEFAULT_MAX_ITERATIONS = 10;

/** Per-session iteration tracker */
const sessionIterations = new Map<string, number>();

/**
 * Check task output for completion tag and manage iteration count.
 * Attaches to `tool.execute.after` — only triggers on `task` tool.
 */
export function createCompletionPromiseHook(
	maxIterations: number = DEFAULT_MAX_ITERATIONS,
) {
	return async (
		input: { tool: string; sessionID: string; args?: unknown },
		output: { output?: string },
	): Promise<void> => {
		if (input.tool.toLowerCase() !== "task") return;
		if (typeof output.output !== "string") return;

		const key = input.sessionID;
		const current = (sessionIterations.get(key) ?? 0) + 1;
		sessionIterations.set(key, current);

		// Check if agent explicitly marked completion
		if (output.output.includes("<done>COMPLETE</done>")) {
			sessionIterations.delete(key);
			return;
		}

		// After threshold, append demand for explicit completion signal
		if (current >= maxIterations) {
			output.output += `\n<system-reminder>
⚠️ COMPLETION CHECK [Iteration ${current}/${maxIterations}]

You have completed ${current} task delegations without confirming plan completion.
If the plan is 100% done, include <done>COMPLETE</done> in your next message.
If tasks remain, continue working — but be intentional, not looping.
</system-reminder>`;
		}
	};
}
