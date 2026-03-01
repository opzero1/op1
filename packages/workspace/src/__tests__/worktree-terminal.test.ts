import { describe, expect, test } from "bun:test";
import {
	formatProjectTmuxWindowName,
	selectTerminalKind,
} from "../worktree/terminal";

describe("worktree terminal selection", () => {
	test("prefers tmux only when explicitly allowed", () => {
		expect(
			selectTerminalKind({
				allowTmux: true,
				inTmuxSession: true,
				processList: "iTerm2",
			}),
		).toBe("tmux");

		expect(
			selectTerminalKind({
				allowTmux: false,
				inTmuxSession: true,
				processList: "iTerm2",
			}),
		).toBe("iterm");
	});

	test("falls back to terminal when no preferred process is available", () => {
		expect(
			selectTerminalKind({
				allowTmux: false,
				inTmuxSession: false,
				processList: "",
			}),
		).toBe("terminal");
	});

	test("formats deterministic tmux window names for project scoping", () => {
		const name = formatProjectTmuxWindowName(
			"project:alpha/team",
			"feature/add continue+handoff",
		);

		expect(name).toContain("op1-");
		expect(name).toContain("project-alpha-team");
		expect(name).toContain("feature-add-continue-handoff");
		expect(name.length).toBeLessThanOrEqual(60);
	});
});
