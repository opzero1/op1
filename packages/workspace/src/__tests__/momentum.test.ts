import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createMomentumHook } from "../hooks/momentum";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("momentum hook", () => {
	test("appends continuation reminder when tasks remain", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-momentum-test-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		await Bun.write(planPath, "- [x] done\n- [ ] next task\n");

		const hook = createMomentumHook({
			readActivePlanState: async () => ({ active_plan: planPath }),
		});

		const output = { output: "base output" };
		await hook({ tool: "task", sessionID: "session-a" }, output);

		expect(output.output).toContain("MOMENTUM");
		expect(output.output).toContain("next task");
	});

	test("appends continuation reminder after bash work when tasks remain", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-momentum-test-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		await Bun.write(planPath, "- [x] done\n- [ ] keep iterating\n");

		const hook = createMomentumHook({
			readActivePlanState: async () => ({ active_plan: planPath }),
		});

		const output = { output: "bash completed" };
		await hook({ tool: "bash", sessionID: "session-bash" }, output);

		expect(output.output).toContain("MOMENTUM");
		expect(output.output).toContain("keep iterating");
	});

	test("uses loop-focus phrasing for autoloop evergreen plans", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-momentum-test-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		await Bun.write(
			planPath,
			[
				"# Agent Harness Autoloop",
				"",
				"- [x] establish state",
				"- [ ] Continue verified harness iterations until explicitly stopped",
			].join("\n"),
		);

		const hook = createMomentumHook({
			readActivePlanState: async () => ({ active_plan: planPath }),
		});

		const output = { output: "loop is running" };
		await hook({ tool: "task", sessionID: "session-autoloop" }, output);

		expect(output.output).toContain("MOMENTUM");
		expect(output.output).toContain(
			"**Loop focus:** Continue verified harness iterations until explicitly stopped",
		);
		expect(output.output).not.toContain("**Next up:**");
		expect(output.output).toContain(
			"keep the loop running from the current focus now",
		);
		expect(output.output).not.toContain("continue with the next task now");
	});

	test("skips reminder when continuation is stopped", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-momentum-test-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		await Bun.write(planPath, "- [ ] pending task\n");

		const hook = createMomentumHook({
			readActivePlanState: async () => ({ active_plan: planPath }),
			shouldContinue: async () => false,
		});

		const output = { output: "base output" };
		await hook({ tool: "task", sessionID: "session-a" }, output);

		expect(output.output).toBe("base output");
	});
});
