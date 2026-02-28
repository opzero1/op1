/**
 * Terminal Spawning (macOS + tmux)
 *
 * Opens a new terminal session in the specified worktree directory.
 * Fallback chain: tmux (when allowed) → iTerm → Ghostty → Terminal.app
 */

import { runCommand } from "../utils.js";
import { escapeAppleScript, FileMutex, withTimeout } from "./primitives.js";

// ──────────────────────────────────────────────
// Terminal Detection
// ──────────────────────────────────────────────

export type TerminalKind = "tmux" | "iterm" | "ghostty" | "warp" | "terminal";

export interface TerminalSelectionInput {
	allowTmux: boolean;
	inTmuxSession: boolean;
	processList: string;
}

export interface TmuxWindowRecord {
	id: string;
	name: string;
	active: boolean;
}

interface TmuxSpawnMetadata {
	tmux_session_name?: string;
	tmux_window_name?: string;
}

export function selectTerminalKind(
	input: TerminalSelectionInput,
): TerminalKind {
	if (input.allowTmux && input.inTmuxSession) return "tmux";

	const processes = input.processList.toLowerCase();
	if (processes.includes("iterm")) return "iterm";
	if (processes.includes("ghostty")) return "ghostty";
	if (processes.includes("warp")) return "warp";

	return "terminal";
}

/**
 * Detect available terminal, preferring tmux if in a tmux session.
 */
async function detectTerminal(allowTmux: boolean): Promise<TerminalKind> {
	let processList = "";

	try {
		const result = await runCommand(
			[
				"osascript",
				"-e",
				'tell application "System Events" to get name of every process',
			],
			"/",
		);
		processList = result;
	} catch {
		processList = "";
	}

	return selectTerminalKind({
		allowTmux,
		inTmuxSession: Boolean(Bun.env.TMUX),
		processList,
	});
}

function sanitizeTmuxName(input: string, maxLength: number): string {
	const sanitized = input
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");

	const fallback = sanitized.length > 0 ? sanitized : "work";
	return fallback.slice(0, maxLength);
}

export function formatProjectTmuxWindowName(
	projectId: string,
	windowName: string,
): string {
	const projectToken = sanitizeTmuxName(projectId, 20);
	const windowToken = sanitizeTmuxName(windowName, 40);
	const scoped = `op1-${projectToken}-${windowToken}`;
	return scoped.slice(0, 60);
}

export async function getCurrentTmuxSessionName(): Promise<string | null> {
	try {
		const output = await runCommand(
			["tmux", "display-message", "-p", "#S"],
			"/",
		);
		const sessionName = output.trim();
		if (!sessionName) return null;
		return sessionName;
	} catch {
		return null;
	}
}

function parseTmuxWindowList(output: string): TmuxWindowRecord[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [id, name, active] = line.split("\t");
			return {
				id: id?.trim() ?? "",
				name: name?.trim() ?? "",
				active: active?.trim() === "1",
			};
		})
		.filter((record) => record.id.length > 0 && record.name.length > 0);
}

export async function listTmuxWindows(
	sessionName: string,
): Promise<TmuxWindowRecord[]> {
	try {
		const output = await runCommand(
			[
				"tmux",
				"list-windows",
				"-t",
				sessionName,
				"-F",
				"#{window_id}\t#{window_name}\t#{window_active}",
			],
			"/",
		);
		return parseTmuxWindowList(output);
	} catch {
		return [];
	}
}

export async function cleanupTmuxDuplicateWindows(input: {
	sessionName: string;
	targetWindowName: string;
	keepWindowId?: string;
}): Promise<void> {
	const windows = await listTmuxWindows(input.sessionName);
	const matching = windows.filter(
		(window) => window.name === input.targetWindowName,
	);
	if (matching.length <= 1) return;

	const survivorId =
		input.keepWindowId ??
		matching.find((window) => window.active)?.id ??
		matching[0]?.id;
	const duplicates = matching.filter((window) => window.id !== survivorId);

	for (const duplicate of duplicates) {
		try {
			await runCommand(["tmux", "kill-window", "-t", duplicate.id], "/");
		} catch {
			// Best-effort cleanup only.
		}
	}
}

// ──────────────────────────────────────────────
// Spawn Functions
// ──────────────────────────────────────────────

async function spawnTmux(
	directory: string,
	windowName: string,
	projectId: string,
): Promise<TmuxSpawnMetadata> {
	const mutex = new FileMutex("tmux", projectId);
	const release = await mutex.acquire();
	const scopedWindowName = formatProjectTmuxWindowName(projectId, windowName);

	try {
		await withTimeout(
			(async () => {
				const sessionName = await getCurrentTmuxSessionName();
				if (sessionName) {
					const existingWindows = await listTmuxWindows(sessionName);
					const matchingScopedWindows = existingWindows.filter(
						(window) => window.name === scopedWindowName,
					);

					if (matchingScopedWindows.length > 0) {
						const windowToReuse =
							matchingScopedWindows.find((window) => window.active) ??
							matchingScopedWindows[0];

						await runCommand(
							["tmux", "select-window", "-t", windowToReuse.id],
							directory,
						);
						await cleanupTmuxDuplicateWindows({
							sessionName,
							targetWindowName: scopedWindowName,
							keepWindowId: windowToReuse.id,
						});
						return;
					}

					await cleanupTmuxDuplicateWindows({
						sessionName,
						targetWindowName: scopedWindowName,
					});
				}

				// Create new tmux window in the current session
				await runCommand(
					["tmux", "new-window", "-n", scopedWindowName, "-c", directory],
					directory,
				);

				const postSpawnSessionName =
					sessionName ?? (await getCurrentTmuxSessionName());
				if (postSpawnSessionName) {
					await cleanupTmuxDuplicateWindows({
						sessionName: postSpawnSessionName,
						targetWindowName: scopedWindowName,
					});
				}
			})(),
			10_000,
			"tmux spawn",
		);

		const sessionName = await getCurrentTmuxSessionName();
		return {
			tmux_session_name: sessionName ?? undefined,
			tmux_window_name: scopedWindowName,
		};
	} finally {
		await release();
	}
}

async function spawnITerm(
	directory: string,
	windowName: string,
): Promise<void> {
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
	options?: { allowTmux?: boolean },
): Promise<{
	terminal: TerminalKind;
	tmux_session_name?: string;
	tmux_window_name?: string;
}> {
	const terminal = await detectTerminal(options?.allowTmux ?? true);
	let tmuxMetadata: TmuxSpawnMetadata | undefined;

	switch (terminal) {
		case "tmux":
			tmuxMetadata = await spawnTmux(directory, windowName, projectId);
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

	return {
		terminal,
		tmux_session_name: tmuxMetadata?.tmux_session_name,
		tmux_window_name: tmuxMetadata?.tmux_window_name,
	};
}
