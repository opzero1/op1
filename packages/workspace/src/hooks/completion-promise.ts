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
const CONTINUATION_TOOLS = new Set(["task", "bash"]);

/** Per-session iteration tracker */
const sessionIterations = new Map<string, number>();

/**
 * Check continuation output for completion tag and manage iteration count.
 * Attaches to `tool.execute.after` — triggers on the same continuation tools as momentum.
 */
export function createCompletionPromiseHook(
	maxIterations: number = DEFAULT_MAX_ITERATIONS,
) {
	return async (
		input: { tool: string; sessionID: string; args?: unknown },
		output: { output?: string },
	): Promise<void> => {
		if (!CONTINUATION_TOOLS.has(input.tool.toLowerCase())) return;
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
If the active plan or loop is truly complete, include <done>COMPLETE</done> in your next message.
If this is an intentional long-running workflow, continue until the user stops you, continuation is deliberately stopped or handed off, or a genuine blocker is reached.
Do not switch into a wrap-up summary or "next steps" handoff while the loop evergreen task is still open.
If work remains, continue working — but be intentional, not looping.
</system-reminder>`;
		}
	};
}
