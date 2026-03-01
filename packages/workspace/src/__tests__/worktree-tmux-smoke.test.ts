import { describe, expect, test } from "bun:test";
import { runCommand } from "../utils";
import {
	cleanupTmuxDuplicateWindows,
	formatProjectTmuxWindowName,
	getCurrentTmuxSessionName,
	listTmuxWindows,
	spawnTerminal,
} from "../worktree/terminal";

async function killWindowsByName(
	sessionName: string,
	windowName: string,
): Promise<void> {
	const windows = await listTmuxWindows(sessionName);
	for (const window of windows) {
		if (window.name !== windowName) continue;
		try {
			await runCommand(["tmux", "kill-window", "-t", window.id], "/");
		} catch {
			// Best-effort cleanup for smoke tests.
		}
	}
}

describe("worktree tmux smoke", () => {
	test("creates, recovers, and tears down scoped tmux windows", async () => {
		if (!Bun.env.TMUX) {
			expect(true).toBe(true);
			return;
		}

		const sessionName = await getCurrentTmuxSessionName();
		if (!sessionName) {
			expect(true).toBe(true);
			return;
		}

		const projectId = `smoke-${Date.now()}`;
		const windowName = formatProjectTmuxWindowName(projectId, "lifecycle");

		await runCommand(["tmux", "new-window", "-n", windowName], "/");

		const created = await listTmuxWindows(sessionName);
		expect(created.some((window) => window.name === windowName)).toBe(true);

		await cleanupTmuxDuplicateWindows({
			sessionName,
			targetWindowName: windowName,
		});

		const recovered = await listTmuxWindows(sessionName);
		expect(recovered.some((window) => window.name === windowName)).toBe(true);

		await killWindowsByName(sessionName, windowName);
		const afterTeardown = await listTmuxWindows(sessionName);
		expect(afterTeardown.some((window) => window.name === windowName)).toBe(
			false,
		);
	});

	test("orphan cleanup removes inactive duplicate windows", async () => {
		if (!Bun.env.TMUX) {
			expect(true).toBe(true);
			return;
		}

		const sessionName = await getCurrentTmuxSessionName();
		if (!sessionName) {
			expect(true).toBe(true);
			return;
		}

		const projectId = `smoke-${Date.now()}`;
		const windowName = formatProjectTmuxWindowName(projectId, "orphan");

		await runCommand(["tmux", "new-window", "-n", windowName], "/");
		await runCommand(["tmux", "new-window", "-n", windowName], "/");

		await cleanupTmuxDuplicateWindows({
			sessionName,
			targetWindowName: windowName,
		});

		const windows = await listTmuxWindows(sessionName);
		const remaining = windows.filter((window) => window.name === windowName);
		expect(remaining.length).toBe(1);

		await killWindowsByName(sessionName, windowName);
	});

	test("spawning same scoped window twice reuses original active window", async () => {
		if (!Bun.env.TMUX) {
			expect(true).toBe(true);
			return;
		}

		const sessionName = await getCurrentTmuxSessionName();
		if (!sessionName) {
			expect(true).toBe(true);
			return;
		}

		const projectId = `smoke-${Date.now()}`;
		const windowLabel = "spawn-twice";
		const scopedWindowName = formatProjectTmuxWindowName(
			projectId,
			windowLabel,
		);

		await runCommand(
			["tmux", "new-window", "-n", scopedWindowName, "-c", "/"],
			"/",
		);

		const beforeSpawn = await listTmuxWindows(sessionName);
		const originalWindow = beforeSpawn.find(
			(window) => window.name === scopedWindowName,
		);
		expect(originalWindow).toBeDefined();
		if (!originalWindow) {
			throw new Error("Expected initial scoped tmux window to exist");
		}
		expect(originalWindow.active).toBe(true);

		await spawnTerminal("/", windowLabel, projectId, { allowTmux: true });
		await spawnTerminal("/", windowLabel, projectId, { allowTmux: true });

		const windows = await listTmuxWindows(sessionName);
		const matchingWindows = windows.filter(
			(window) => window.name === scopedWindowName,
		);
		expect(matchingWindows.length).toBe(1);
		const matchingWindow = matchingWindows[0];
		if (!matchingWindow) {
			throw new Error("Expected exactly one scoped tmux window after spawn");
		}
		expect(matchingWindow.id).toBe(originalWindow.id);
		expect(matchingWindow.active).toBe(true);

		await killWindowsByName(sessionName, scopedWindowName);
	});
});
