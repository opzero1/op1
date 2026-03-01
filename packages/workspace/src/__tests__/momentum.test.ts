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
