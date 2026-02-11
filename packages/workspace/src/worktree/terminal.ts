/**
 * Terminal Spawning (macOS + tmux)
 *
 * Opens a new terminal session in the specified worktree directory.
 * Fallback chain: tmux → iTerm → Ghostty → Terminal.app
 */

import { runCommand } from "../utils.js";
import { escapeShell, escapeAppleScript, FileMutex, withTimeout } from "./primitives.js";

// ──────────────────────────────────────────────
// Terminal Detection
// ──────────────────────────────────────────────

type TerminalKind = "tmux" | "iterm" | "ghostty" | "warp" | "terminal";

/**
 * Detect available terminal, preferring tmux if in a tmux session.
 */
async function detectTerminal(): Promise<TerminalKind> {
	// Check if we're in a tmux session
	if (process.env.TMUX) return "tmux";

	// Check which terminals are installed
	try {
		const result = await runCommand(
			["osascript", "-e", 'tell application "System Events" to get name of every process'],
			"/",
		);
		const processes = result.toLowerCase();

		if (processes.includes("iterm")) return "iterm";
		if (processes.includes("ghostty")) return "ghostty";
		if (processes.includes("warp")) return "warp";
	} catch {
		// Fall through to default
	}

	return "terminal";
}

// ──────────────────────────────────────────────
// Spawn Functions
// ──────────────────────────────────────────────

async function spawnTmux(
	directory: string,
	windowName: string,
	projectId: string,
): Promise<void> {
	const mutex = new FileMutex("tmux", projectId);
	const release = await mutex.acquire();

	try {
		await withTimeout(
			(async () => {
				// Create new tmux window in the current session
				await runCommand(
					["tmux", "new-window", "-n", windowName, "-c", directory],
					directory,
				);
			})(),
			10_000,
			"tmux spawn",
		);
	} finally {
		await release();
	}
}

async function spawnITerm(directory: string, windowName: string): Promise<void> {
	const escapedDir = escapeAppleScript(directory);
	const escapedName = escapeAppleScript(windowName);

	const script = `
		tell application "iTerm2"
			create window with default profile
			tell current session of current window
				write text "cd ${escapedDir} && clear"
				set name to "${escapedName}"
			end tell
		end tell
	`;

	await runCommand(["osascript", "-e", script], "/");
}

async function spawnGhostty(directory: string): Promise<void> {
	// Ghostty uses CLI to open new windows
	await runCommand(
		["open", "-na", "Ghostty", "--args", `--working-directory=${directory}`],
		"/",
	);
}

async function spawnTerminalApp(directory: string): Promise<void> {
	const escapedDir = escapeAppleScript(directory);

	const script = `
		tell application "Terminal"
			do script "cd ${escapedDir} && clear"
			activate
		end tell
	`;

	await runCommand(["osascript", "-e", script], "/");
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Open a new terminal window/tab in the given directory.
 * Automatically detects the best terminal to use.
 */
export async function spawnTerminal(
	directory: string,
	windowName: string,
	projectId: string,
): Promise<{ terminal: TerminalKind }> {
	const terminal = await detectTerminal();

	switch (terminal) {
		case "tmux":
			await spawnTmux(directory, windowName, projectId);
			break;
		case "iterm":
			await spawnITerm(directory, windowName);
			break;
		case "ghostty":
			await spawnGhostty(directory);
			break;
		case "warp":
			// Warp doesn't have great AppleScript support — use open
			await runCommand(["open", "-a", "Warp", directory], "/");
			break;
		case "terminal":
			await spawnTerminalApp(directory);
			break;
	}

	return { terminal };
}
