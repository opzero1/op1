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

	test("autonomy policy reminder also catches proceed phrasing", async () => {
		const hook = createAutonomyPolicyHook();
		const output = {
			output: "Would you like me to proceed with the next task?",
		};

		await hook({ tool: "task", sessionID: "session-proceed" }, output);

		expect(output.output).toContain("AUTO-CONTINUE POLICY");
		expect(output.output).toContain("Continue execution automatically");
	});

	test("autonomy policy enforces decision rounds before user escalation", async () => {
		const hook = createAutonomyPolicyHook();
		const output = { output: "I need your decision on the best approach" };

		await hook({ tool: "task", sessionID: "session-decision-gate" }, output);

		expect(output.output).toContain("DECISION PROTOCOL ENFORCEMENT");
		expect(output.output).toContain("Rounds completed so far: 0");
		expect(output.output).toContain("Remaining before user escalation: 3");
	});

	test("autonomy policy tracks oracle rounds before escalating", async () => {
		const hook = createAutonomyPolicyHook();

		await hook(
			{
				tool: "task",
				sessionID: "session-decision-rounds",
				args: { subagent_type: "oracle" },
			},
			{ output: "oracle complete" },
		);

		const output = { output: "I need your decision on the best approach" };
		await hook({ tool: "task", sessionID: "session-decision-rounds" }, output);

		expect(output.output).toContain("DECISION PROTOCOL ENFORCEMENT");
		expect(output.output).toContain("Rounds completed so far: 1");
		expect(output.output).toContain("Remaining before user escalation: 2");
	});

	test("autonomy policy opens the gate after three decision rounds", async () => {
		const hook = createAutonomyPolicyHook();

		for (let round = 0; round < 3; round++) {
			await hook(
				{
					tool: "task",
					sessionID: "session-decision-open",
					args: { subagent_type: "oracle" },
				},
				{ output: `oracle round ${round + 1}` },
			);
		}

		const output = { output: "I need your decision on the best approach" };
		await hook({ tool: "task", sessionID: "session-decision-open" }, output);

		expect(output.output).not.toContain("DECISION PROTOCOL ENFORCEMENT");
	});

	test("autonomy policy clears decision rounds after COMPLETE", async () => {
		const hook = createAutonomyPolicyHook();

		await hook(
			{
				tool: "task",
				sessionID: "session-decision-reset",
				args: { subagent_type: "oracle" },
			},
			{ output: "oracle complete" },
		);

		await hook(
			{ tool: "task", sessionID: "session-decision-reset" },
			{ output: "<done>COMPLETE</done>" },
		);

		const output = { output: "I need your decision on the best approach" };
		await hook({ tool: "task", sessionID: "session-decision-reset" }, output);

		expect(output.output).toContain("DECISION PROTOCOL ENFORCEMENT");
		expect(output.output).toContain("Rounds completed so far: 0");
	});

	test("completion promise reminder demands explicit completion signal", async () => {
		const hook = createCompletionPromiseHook(1);
		const output = { output: "still working" };

		await hook({ tool: "task", sessionID: "session-c" }, output);

		expect(output.output).toContain("COMPLETION CHECK");
		expect(output.output).toContain("<done>COMPLETE</done>");
		expect(output.output).toContain("intentional /autoloop run");
		expect(output.output).toContain(
			'Do not switch into a wrap-up summary or "next steps" handoff',
		);
	});

	test("autonomy policy converts recovery option menus into autonomous recovery reminders", async () => {
		const hook = createAutonomyPolicyHook();
		const output = {
			output:
				"State file missing. Options: A) Create new state B) Continue with context only C) Restore from backup",
		};

		await hook({ tool: "task", sessionID: "session-recovery" }, output);

		expect(output.output).toContain("AUTONOMOUS RECOVERY POLICY");
		expect(output.output).toContain("pick the safest recovery path yourself");
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

	test("stacked reminders keep autoloop momentum wording compact", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-prompt-budget-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		await Bun.write(
			planPath,
			[
				"# Agent Harness Autoloop",
				"",
				"- [x] done",
				"- [ ] Continue verified harness iterations until explicitly stopped",
			].join("\n"),
		);

		const momentum = createMomentumHook({
			readActivePlanState: async () => ({ active_plan: planPath }),
		});
		const autonomy = createAutonomyPolicyHook();
		const completion = createCompletionPromiseHook(1);
		const output = { output: "loop is running" };

		await momentum({ tool: "task", sessionID: "session-autoloop" }, output);
		await autonomy({ tool: "task", sessionID: "session-autoloop" }, output);
		await completion({ tool: "task", sessionID: "session-autoloop" }, output);

		expect(output.output).toContain("**Loop focus:**");
		expect(output.output).toContain(
			"keep the loop running from the current focus now",
		);
		expect(output.output).not.toContain("**Next up:**");
		expect(output.output.length).toBeLessThan(2500);
	});
});
