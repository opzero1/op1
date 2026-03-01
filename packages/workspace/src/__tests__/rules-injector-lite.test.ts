import { afterEach, describe, expect, test } from "bun:test";

import {
	createRulesInjectorLiteHook,
	resetRulesInjectorLiteState,
} from "../hooks/rules-injector-lite";

afterEach(() => {
	resetRulesInjectorLiteState();
});

describe("rules injector lite", () => {
	test("injects matching phase/tool rule once per session", async () => {
		const hook = createRulesInjectorLiteHook({
			getCurrentPhase: async () => "2",
		});

		const output = {
			title: "Edit file",
			output: "ok",
			metadata: {},
		};

		await hook(
			{ tool: "edit", sessionID: "session-a", callID: "call-1" },
			output,
		);

		expect(output.output).toContain("rule:read-before-write:phase-2");
		expect(output.output).toContain(
			"rule:hashline-structural-boundaries:phase-2",
		);

		const firstPass = output.output;

		await hook(
			{ tool: "edit", sessionID: "session-a", callID: "call-2" },
			output,
		);

		expect(output.output).toBe(firstPass);
	});

	test("keeps injection scoped per session", async () => {
		const hook = createRulesInjectorLiteHook({
			getCurrentPhase: async () => "2",
		});

		const sessionAOutput = {
			title: "Edit file",
			output: "ok-a",
			metadata: {},
		};

		const sessionBOutput = {
			title: "Edit file",
			output: "ok-b",
			metadata: {},
		};

		await hook(
			{ tool: "edit", sessionID: "session-a", callID: "call-a" },
			sessionAOutput,
		);

		await hook(
			{ tool: "edit", sessionID: "session-b", callID: "call-b" },
			sessionBOutput,
		);

		expect(sessionAOutput.output).toContain("rule:read-before-write:phase-2");
		expect(sessionBOutput.output).toContain("rule:read-before-write:phase-2");
	});

	test("injects only matching tools", async () => {
		const hook = createRulesInjectorLiteHook({
			getCurrentPhase: async () => "2",
		});

		const output = {
			title: "List plans",
			output: "done",
			metadata: {},
		};

		await hook(
			{ tool: "plan_list", sessionID: "session-c", callID: "call-c" },
			output,
		);

		expect(output.output).toBe("done");
	});

	test("respects phase scoping", async () => {
		const hook = createRulesInjectorLiteHook({
			getCurrentPhase: async () => "3",
		});

		const output = {
			title: "Edit file",
			output: "phase3",
			metadata: {},
		};

		await hook(
			{ tool: "edit", sessionID: "session-d", callID: "call-d" },
			output,
		);

		expect(output.output).toContain("rule:read-before-write:phase-3");
		expect(output.output).not.toContain(
			"rule:hashline-structural-boundaries:phase-3",
		);
	});
});
