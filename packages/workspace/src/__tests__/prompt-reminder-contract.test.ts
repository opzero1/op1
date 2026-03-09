import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createAutonomyPolicyHook } from "../hooks/autonomy-policy";
import { createCompletionPromiseHook } from "../hooks/completion-promise";
import { createMomentumHook } from "../hooks/momentum";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("prompt reminder contracts", () => {
	test("momentum reminder keeps the continuation contract intact", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-prompt-contract-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		await Bun.write(planPath, "- [x] done\n- [ ] next task\n");

		const hook = createMomentumHook({
			readActivePlanState: async () => ({ active_plan: planPath }),
		});

		const output = { output: "base output" };
		await hook({ tool: "task", sessionID: "session-a" }, output);

		expect(output.output).toContain("MOMENTUM");
		expect(output.output).toContain("Do NOT stop");
		expect(output.output).toContain("Continue automatically");
	});

	test("autonomy policy reminder suppresses continue prompts", async () => {
		const hook = createAutonomyPolicyHook();
		const output = { output: "I can continue if you want" };

		await hook({ tool: "task", sessionID: "session-b" }, output);

		expect(output.output).toContain("AUTO-CONTINUE POLICY");
		expect(output.output).toContain('Do not ask "should I continue"');
	});

	test("completion promise reminder demands explicit completion signal", async () => {
		const hook = createCompletionPromiseHook(1);
		const output = { output: "still working" };

		await hook({ tool: "task", sessionID: "session-c" }, output);

		expect(output.output).toContain("COMPLETION CHECK");
		expect(output.output).toContain("<done>COMPLETE</done>");
	});

	test("stacked reminders stay under a compact output budget", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-prompt-budget-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		await Bun.write(planPath, "- [x] done\n- [ ] next task\n");

		const momentum = createMomentumHook({
			readActivePlanState: async () => ({ active_plan: planPath }),
		});
		const autonomy = createAutonomyPolicyHook();
		const completion = createCompletionPromiseHook(1);
		const output = { output: "I can continue if you want" };

		await momentum({ tool: "task", sessionID: "session-d" }, output);
		await autonomy({ tool: "task", sessionID: "session-d" }, output);
		await completion({ tool: "task", sessionID: "session-d" }, output);

		expect(output.output).toContain("MOMENTUM");
		expect(output.output).toContain("AUTO-CONTINUE POLICY");
		expect(output.output).toContain("COMPLETION CHECK");
		expect(output.output.length).toBeLessThan(2500);
	});
});
