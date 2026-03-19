import { describe, expect, test } from "bun:test";

import {
	checkInteractiveCommand,
	createToolExecuteBeforeHook,
} from "../hooks/non-interactive-guard";

describe("non-interactive guard", () => {
	test("detects interactive commands and allows safe alternatives", () => {
		expect(checkInteractiveCommand("vim README.md")).toContain(
			"BLOCKED: This command requires interactive input",
		);
		expect(checkInteractiveCommand("git rebase -i HEAD~2")).toContain(
			"git rebase -i",
		);
		expect(checkInteractiveCommand('python -c "print(1)"')).toBeUndefined();
		expect(checkInteractiveCommand("git rebase main")).toBeUndefined();
	});

	test("rewrites blocked bash commands before execution", async () => {
		const hook = createToolExecuteBeforeHook();
		const output = {
			args: { command: "nvim packages/workspace/src/index.ts" },
		};

		await hook(
			{ tool: "bash", sessionID: "session-guard", callID: "call-guard" },
			output,
		);

		expect(output.args.command).toContain("echo");
		expect(output.args.command).toContain(
			"BLOCKED: This command requires interactive input",
		);
	});

	test("leaves non-bash tools untouched", async () => {
		const hook = createToolExecuteBeforeHook();
		const output = { args: { command: "vim README.md" } };

		await hook(
			{ tool: "read", sessionID: "session-safe", callID: "call-safe" },
			output,
		);

		expect(output.args.command).toBe("vim README.md");
	});
});
