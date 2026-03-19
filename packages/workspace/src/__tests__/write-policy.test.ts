import { describe, expect, test } from "bun:test";

import { createWritePolicyHook } from "../hooks/write-policy";

describe("write policy hook", () => {
	test("warns when build agent writes directly via subagent metadata", async () => {
		const hook = createWritePolicyHook();
		const output = { output: "edit applied" };

		await hook({ tool: "write", args: { subagent_type: "build" } }, output);

		expect(output.output).toContain("HANDOFF POLICY");
		expect(output.output).toContain('subagent_type="coder"');
	});

	test("warns when plan agent writes directly via agent metadata", async () => {
		const hook = createWritePolicyHook();
		const output = { output: "edit applied" };

		await hook({ tool: "edit", args: { agent: "plan" } }, output);

		expect(output.output).toContain("HANDOFF POLICY");
		expect(output.output).toContain("Proceeding with the edit");
	});

	test("skips warning for direct edit override", async () => {
		const hook = createWritePolicyHook();
		const output = { output: "edit applied" };

		await hook(
			{ tool: "write", args: { subagent_type: "build", directEdit: true } },
			output,
		);

		expect(output.output).toBe("edit applied");
	});

	test("skips warning for non-orchestrator agents", async () => {
		const hook = createWritePolicyHook();
		const output = { output: "edit applied" };

		await hook({ tool: "write", args: { subagent_type: "coder" } }, output);

		expect(output.output).toBe("edit applied");
	});
});
