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
});
