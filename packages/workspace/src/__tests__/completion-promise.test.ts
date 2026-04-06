import { describe, expect, test } from "bun:test";
import { createCompletionPromiseHook } from "../hooks/completion-promise";

describe("completion promise hook", () => {
	test("adds completion reminder after threshold", async () => {
		const hook = createCompletionPromiseHook(2);
		const output = { output: "first" };

		await hook({ tool: "task", sessionID: "session-a" }, output);
		expect(output.output).toBe("first");

		await hook({ tool: "task", sessionID: "session-a" }, output);
		expect(output.output).toContain("COMPLETION CHECK");
		expect(output.output).toContain(
			"If the active plan or loop is truly complete",
		);
		expect(output.output).toContain("intentional long-running workflow");
		expect(output.output).toContain(
			'Do not switch into a wrap-up summary or "next steps" handoff',
		);
	});

	test("resets iteration tracking when completion tag appears", async () => {
		const hook = createCompletionPromiseHook(1);
		const output = { output: "<done>COMPLETE</done>" };

		await hook({ tool: "task", sessionID: "session-b" }, output);
		expect(output.output).toContain("<done>COMPLETE</done>");

		const followUp = { output: "follow-up" };
		await hook({ tool: "task", sessionID: "session-b" }, followUp);
		expect(followUp.output).toContain("COMPLETION CHECK");
	});

	test("tracks bash-driven continuation loops too", async () => {
		const hook = createCompletionPromiseHook(1);
		const output = { output: "bash step complete" };

		await hook({ tool: "bash", sessionID: "session-bash" }, output);

		expect(output.output).toContain("COMPLETION CHECK");
		expect(output.output).toContain("intentional long-running workflow");
	});

	test("blocks COMPLETE when background child obligations remain", async () => {
		const hook = createCompletionPromiseHook({
			maxIterations: 1,
			getJoinBlockers: async () => ({
				rootSessionID: "root-1",
				blockers: [
					{
						task_id: "task-1",
						status: "running",
						reason: "Still executing child work.",
					},
				],
			}),
		});
		const output = { output: "done for now\n<done>COMPLETE</done>" };

		await hook({ tool: "task", sessionID: "session-guard" }, output);

		expect(output.output).not.toContain("done for now\n<done>COMPLETE</done>");
		expect(output.output).toContain("ROOT JOIN GUARD");
		expect(output.output).toContain(
			"task-1 (running: Still executing child work.)",
		);
	});
});
