/**
 * Momentum (Boulder Continuation) Hook
 *
 * After a subagent task completes, checks the active plan for unfinished tasks.
 * If tasks remain, injects a continuation prompt urging the agent to keep going.
 *
 * Inspired by oh-my-opencode's "boulder continuation" pattern — the agent rolls
 * its boulder every day and doesn't stop until the plan is 100% complete.
 */

export interface MomentumDeps {
	readActivePlanState: () => Promise<{ active_plan: string } | null>;
	shouldContinue?: (sessionID: string) => Promise<boolean>;
}

/** Tools that should trigger continuation checks */
const CONTINUATION_TOOLS = new Set(["task"]);

/**
 * Count completed and total tasks in plan content by looking at `- [x]` / `- [ ]` markers.
 */
function countPlanTasks(content: string): { done: number; total: number } {
	const taskPattern = /^[\t ]*- \[([ x])\]/gm;
	let done = 0;
	let total = 0;

	for (const match of content.matchAll(taskPattern)) {
		total++;
		if (match[1] === "x") done++;
	}

	return { done, total };
}

/**
 * Find the next incomplete task (first `- [ ]` line) in the plan.
 */
function findNextTask(content: string): string | null {
	const match = content.match(/^[\t ]*- \[ \] .+$/m);
	return match ? match[0].trim().replace(/^- \[ \] /, "") : null;
}

/**
 * Build the continuation prompt that pushes the agent to keep going.
 */
function buildContinuationPrompt(
	done: number,
	total: number,
	nextTask: string | null,
): string {
	const remaining = total - done;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;

	let prompt = `\n<system-reminder>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🪨 MOMENTUM — Keep Rolling the Boulder
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Progress: ${done}/${total} tasks complete (${pct}%)
Remaining: ${remaining} task${remaining !== 1 ? "s" : ""}`;

	if (nextTask) {
		prompt += `\n\n**Next up:** ${nextTask}`;
	}

	prompt += `

**Do NOT stop.** Read the plan (plan_read), then continue with the next task now.
Do not ask the user for permission to continue. Continue automatically.
If you need to record progress, use notepad_write before continuing.
</system-reminder>`;

	return prompt;
}

/**
 * Create the momentum hook handler.
 * Attaches to `tool.execute.after` — triggers only when the `task` tool completes.
 */
export function createMomentumHook(deps: MomentumDeps) {
	return async (
		input: { tool: string; sessionID?: string; args?: unknown },
		output: { output?: string },
	): Promise<void> => {
		const toolName = input.tool.toLowerCase();
		if (!CONTINUATION_TOOLS.has(toolName)) return;

		if (deps.shouldContinue && input.sessionID) {
			const allowed = await deps.shouldContinue(input.sessionID);
			if (!allowed) return;
		}

		if (
			typeof output.output === "string" &&
			output.output.includes("<done>COMPLETE</done>")
		) {
			return;
		}

		const state = await deps.readActivePlanState();
		if (!state) return;

		try {
			const planFile = Bun.file(state.active_plan);
			if (!(await planFile.exists())) return;

			const content = await planFile.text();
			const { done, total } = countPlanTasks(content);

			// No tasks or all done — nothing to push
			if (total === 0 || done >= total) return;

			const nextTask = findNextTask(content);
			const prompt = buildContinuationPrompt(done, total, nextTask);

			if (typeof output.output === "string") {
				output.output = output.output + prompt;
			}
		} catch {
			// Degrade silently — momentum is non-critical
		}
	};
}
