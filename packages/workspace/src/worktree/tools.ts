/**
 * Worktree Lifecycle Tools
 *
 * Plugin tools for creating, listing, and deleting git worktrees.
 * Each session gets its own worktree for isolated development.
 */

import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import {
	basename,
	copyFile,
	join,
	mkdir,
	relative,
	resolve,
	stat,
	symlink,
} from "../bun-compat.js";

import { runCommand } from "../utils.js";
import { sanitizeBranchName, withTimeout } from "./primitives.js";
import { createWorktreeDB, type WorktreeDB } from "./state.js";
import { spawnTerminal, type TerminalKind } from "./terminal.js";

// ──────────────────────────────────────────────
// Config Defaults
// ──────────────────────────────────────────────

interface WorktreeConfig {
	/** Files/dirs to copy into new worktrees */
	copy: string[];
	/** Files/dirs to symlink from main into worktrees */
	symlinks: string[];
	/** Base directory for worktrees (default: ../{project}-worktrees) */
	baseDir?: string;
}

interface WorktreeToolOptions {
	tmuxOrchestration?: boolean;
	onTerminalSpawn?: (input: {
		sessionID: string;
		branch: string;
		worktreePath: string;
		terminal: TerminalKind;
		tmuxSessionName?: string;
		tmuxWindowName?: string;
	}) => Promise<void>;
}

const DEFAULT_CONFIG: WorktreeConfig = {
	copy: [".env", ".env.local"],
	symlinks: ["node_modules", ".bun"],
};

// ──────────────────────────────────────────────
// Worktree Operations
// ──────────────────────────────────────────────

async function copyFiles(
	from: string,
	to: string,
	files: string[],
): Promise<string[]> {
	const copied: string[] = [];
	for (const file of files) {
		try {
			const src = join(from, file);
			const dest = join(to, file);
			const srcStat = await stat(src).catch(() => null);
			if (srcStat?.isFile()) {
				await copyFile(src, dest);
				copied.push(file);
			}
		} catch {
			// Skip files that don't exist
		}
	}
	return copied;
}

async function createSymlinks(
	from: string,
	to: string,
	targets: string[],
): Promise<string[]> {
	const linked: string[] = [];
	for (const target of targets) {
		try {
			const src = join(from, target);
			const dest = join(to, target);
			const srcStat = await stat(src).catch(() => null);
			if (srcStat) {
				await symlink(src, dest).catch(() => {});
				linked.push(target);
			}
		} catch {
			// Skip targets that don't exist
		}
	}
	return linked;
}

function parseWorktreeList(output: string): Array<{
	path: string;
	head: string;
	branch: string;
}> {
	const worktrees: Array<{ path: string; head: string; branch: string }> = [];
	let current: Partial<{ path: string; head: string; branch: string }> = {};

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) {
				worktrees.push(
					current as { path: string; head: string; branch: string },
				);
			}
			current = { path: line.slice(9) };
			continue;
		}

		if (line.startsWith("HEAD ")) {
			current.head = line.slice(5, 12);
			continue;
		}

		if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace("refs/heads/", "");
		}
	}

	if (current.path) {
		worktrees.push(current as { path: string; head: string; branch: string });
	}

	return worktrees;
}

async function isDirtyWorktree(worktreePath: string): Promise<boolean> {
	const status = await runCommand(
		["git", "status", "--porcelain"],
		worktreePath,
	);
	return status.trim().length > 0;
}

async function isLinkedWorktree(directory: string): Promise<boolean> {
	try {
		const [gitDirRaw, commonDirRaw] = await Promise.all([
			runCommand(["git", "rev-parse", "--git-dir"], directory),
			runCommand(["git", "rev-parse", "--git-common-dir"], directory),
		]);

		const gitDir = resolve(directory, gitDirRaw.trim());
		const commonDir = resolve(directory, commonDirRaw.trim());
		return gitDir !== commonDir;
	} catch {
		return false;
	}
}

// ──────────────────────────────────────────────
// Tool Definitions
// ──────────────────────────────────────────────

export function createWorktreeTools(
	directory: string,
	projectId: string,
	options: WorktreeToolOptions = {},
): Record<string, ToolDefinition> {
	let db: WorktreeDB | null = null;

	async function getDB(): Promise<WorktreeDB> {
		if (!db) {
			db = await createWorktreeDB(projectId);
		}
		return db;
	}

	function getWorktreeBase(): string {
		const projectName = basename(directory);
		return join(directory, "..", `${projectName}-worktrees`);
	}

	return {
		worktree_create: tool({
			description:
				"Create a new git worktree for isolated development. Opens a terminal in the new worktree.",
			args: {
				branch: tool.schema
					.string()
					.describe(
						"Branch name for the worktree (will be created if it doesn't exist)",
					),
				base: tool.schema
					.string()
					.optional()
					.describe("Base branch to create from (default: current branch)"),
				open_terminal: tool.schema
					.boolean()
					.optional()
					.describe(
						"Whether to open a terminal in the worktree (default: true)",
					),
			},
			async execute(args, toolCtx) {
				if (!toolCtx?.sessionID) {
					return "❌ worktree_create requires sessionID.";
				}

				if (await isLinkedWorktree(directory)) {
					return "❌ Cannot create a nested worktree from an already-assigned child worktree root. Return to the primary execution root first.";
				}

				const sanitized = sanitizeBranchName(args.branch);
				if (!sanitized) {
					return `❌ Invalid branch name: "${args.branch}". Use alphanumeric characters, dashes, dots, or slashes.`;
				}

				const worktreeBase = getWorktreeBase();
				await mkdir(worktreeBase, { recursive: true });

				const stateDB = await getDB();
				const existingSession = stateDB.getSession(toolCtx.sessionID);
				if (existingSession) {
					const relExistingPath = relative(
						directory,
						existingSession.worktree_path,
					);
					return `❌ Session already has a tracked worktree at ${relExistingPath}. Leave or delete it before creating another.`;
				}

				const worktreePath = join(worktreeBase, sanitized.replace(/\//g, "-"));

				// Check if worktree already exists
				try {
					const existingStat = await stat(worktreePath);
					if (existingStat.isDirectory()) {
						return `❌ Worktree already exists at ${relative(directory, worktreePath)}. Use worktree_list to see active worktrees.`;
					}
				} catch {
					// Doesn't exist — good
				}

				try {
					// Create the worktree
					const gitArgs = ["git", "worktree", "add"];
					if (args.base) {
						gitArgs.push("-b", sanitized, worktreePath, args.base);
					} else {
						gitArgs.push("-b", sanitized, worktreePath);
					}

					await withTimeout(
						runCommand(gitArgs, directory),
						30_000,
						"git worktree add",
					);

					// Copy env files and symlink node_modules
					const copied = await copyFiles(
						directory,
						worktreePath,
						DEFAULT_CONFIG.copy,
					);
					const linked = await createSymlinks(
						directory,
						worktreePath,
						DEFAULT_CONFIG.symlinks,
					);

					// Track in database
					try {
						stateDB.addSession(toolCtx.sessionID, worktreePath, sanitized);
					} catch (error) {
						await runCommand(
							["git", "worktree", "remove", "--force", worktreePath],
							directory,
						).catch(() => undefined);
						throw error;
					}

					// Open terminal if requested
					const openTerminal = args.open_terminal !== false;
					let terminalInfo = "";
					if (openTerminal) {
						try {
							const result = await spawnTerminal(
								worktreePath,
								sanitized,
								projectId,
								{ allowTmux: options.tmuxOrchestration ?? true },
							);

							if (toolCtx?.sessionID && options.onTerminalSpawn) {
								await options.onTerminalSpawn({
									sessionID: toolCtx.sessionID,
									branch: sanitized,
									worktreePath,
									terminal: result.terminal,
									tmuxSessionName: result.tmux_session_name,
									tmuxWindowName: result.tmux_window_name,
								});
							}

							terminalInfo = `\n🖥️ Opened ${result.terminal} terminal in worktree.`;
						} catch {
							terminalInfo = "\n⚠️ Could not open terminal automatically.";
						}
					}

					const relPath = relative(directory, worktreePath);
					const details: string[] = [
						`✅ Worktree created at ${relPath}`,
						`📌 Branch: ${sanitized}`,
					];
					if (copied.length > 0)
						details.push(`📋 Copied: ${copied.join(", ")}`);
					if (linked.length > 0)
						details.push(`🔗 Symlinked: ${linked.join(", ")}`);
					if (terminalInfo) details.push(terminalInfo);

					return details.join("\n");
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return `❌ Failed to create worktree: ${msg}`;
				}
			},
		}),

		worktree_list: tool({
			description: "List active git worktrees for this project.",
			args: {},
			async execute() {
				try {
					// Use git worktree list for ground truth
					const output = await runCommand(
						["git", "worktree", "list", "--porcelain"],
						directory,
					);

					if (!output.trim()) {
						return "No worktrees found.";
					}

					const worktrees = parseWorktreeList(output);

					if (worktrees.length === 0) {
						return "No worktrees found.";
					}

					const lines = ["## Git Worktrees\n"];
					for (const wt of worktrees) {
						const relPath = relative(directory, wt.path);
						const isMain = relPath === "" || relPath === ".";
						const label = isMain ? "(main)" : "";
						lines.push(`- **${wt.branch || "detached"}** ${label}`);
						lines.push(`  Path: ${relPath || "."}`);
						lines.push(`  HEAD: ${wt.head || "unknown"}`);
						lines.push("");
					}

					return lines.join("\n");
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return `❌ Failed to list worktrees: ${msg}`;
				}
			},
		}),

		worktree_enter: tool({
			description:
				"Mark this session as the currently entered worktree context.",
			args: {},
			async execute(_args, toolCtx) {
				if (!toolCtx?.sessionID) {
					return "❌ worktree_enter requires sessionID.";
				}

				try {
					const stateDB = await getDB();
					const session = stateDB.getSession(toolCtx.sessionID);
					if (!session) {
						return "❌ No tracked worktree session found for this session. Create one with worktree_create first.";
					}

					stateDB.enterSession(toolCtx.sessionID);
					const relPath = relative(directory, session.worktree_path);
					return `✅ Entered worktree context: ${relPath}\n📌 Branch: ${session.branch}`;
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return `❌ Failed to enter worktree context: ${msg}`;
				}
			},
		}),

		worktree_leave: tool({
			description:
				"Leave the currently entered worktree context. Blocks on dirty worktree unless force=true.",
			args: {
				force: tool.schema
					.boolean()
					.optional()
					.describe("Force leave even when there are uncommitted changes."),
			},
			async execute(args, toolCtx) {
				if (!toolCtx?.sessionID) {
					return "❌ worktree_leave requires sessionID.";
				}

				const force = args.force === true;

				try {
					const stateDB = await getDB();
					const lifecycle = stateDB.getLifecycleState();

					if (
						!lifecycle?.current_session_id ||
						!lifecycle.current_worktree_path
					) {
						return "⚠️ No active worktree context to leave.";
					}

					if (lifecycle.current_session_id !== toolCtx.sessionID && !force) {
						return "❌ This session is not the active entered worktree context. Use force=true to clear it.";
					}

					if (!force) {
						const isDirty = await isDirtyWorktree(
							lifecycle.current_worktree_path,
						);
						if (isDirty) {
							return "❌ Cannot leave worktree: uncommitted changes detected. Commit/stash first or use force=true.";
						}
					}

					const left = stateDB.leaveSession(toolCtx.sessionID, force);
					if (!left) {
						return "⚠️ No active worktree context to leave.";
					}

					const relPath = relative(directory, lifecycle.current_worktree_path);
					return `✅ Left worktree context: ${relPath}`;
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return `❌ Failed to leave worktree context: ${msg}`;
				}
			},
		}),

		worktree_delete: tool({
			description:
				"Delete a git worktree. Optionally creates a snapshot commit before deletion.",
			args: {
				branch: tool.schema
					.string()
					.describe("Branch name of the worktree to delete"),
				snapshot: tool.schema
					.boolean()
					.optional()
					.describe("Create a snapshot commit before deleting (default: true)"),
				force: tool.schema
					.boolean()
					.optional()
					.describe(
						"Force deletion if this is the currently entered worktree context.",
					),
			},
			async execute(args, _toolCtx) {
				const branch = args.branch.trim();
				const shouldSnapshot = args.snapshot !== false;
				const force = args.force === true;
				let snapshotCommitted = false;
				let hadDirtyChanges = false;

				try {
					// Find the worktree path
					const output = await runCommand(
						["git", "worktree", "list", "--porcelain"],
						directory,
					);

					const worktrees = parseWorktreeList(output);
					const matched = worktrees.find((item) => item.branch === branch);
					const worktreePath = matched?.path ?? null;

					if (!worktreePath) {
						return `❌ No worktree found for branch "${branch}".`;
					}

					// Don't allow deleting the main worktree
					const relPath = relative(directory, worktreePath);
					if (relPath === "" || relPath === ".") {
						return "❌ Cannot delete the main worktree.";
					}

					const stateDB = await getDB();
					const lifecycle = stateDB.getLifecycleState();
					if (lifecycle?.current_worktree_path === worktreePath && !force) {
						return "❌ Cannot delete currently entered worktree context. Leave it first or use force=true.";
					}

					// Snapshot uncommitted changes before deletion.
					if (shouldSnapshot) {
						const statusWithIgnored = await runCommand(
							["git", "status", "--porcelain", "--ignored"],
							worktreePath,
						);
						const statusLines = statusWithIgnored
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						const ignoredEntries = statusLines.filter((line) =>
							line.startsWith("!! "),
						);
						const snapshotCandidates = statusLines.filter(
							(line) => !line.startsWith("!! "),
						);
						hadDirtyChanges = snapshotCandidates.length > 0;

						if (ignoredEntries.length > 0 && !force) {
							return "❌ Worktree has ignored files that cannot be snapshotted. Deletion aborted. Use force=true to delete anyway.";
						}

						if (hadDirtyChanges) {
							try {
								await runCommand(["git", "add", "-A"], worktreePath);
								await runCommand(
									[
										"git",
										"commit",
										"-m",
										`snapshot: auto-save before worktree deletion [${branch}]`,
									],
									worktreePath,
								);

								snapshotCommitted = true;
							} catch (error) {
								const message =
									error instanceof Error ? error.message : String(error);
								return `❌ Failed to snapshot changes before deletion: ${message}`;
							}

							const postCommitStatus = await runCommand(
								["git", "status", "--porcelain"],
								worktreePath,
							);
							if (postCommitStatus.trim().length > 0) {
								return "❌ Snapshot verification failed: worktree still has pending changes. Deletion aborted.";
							}
						}
					}

					// Remove worktree
					const removeArgs = ["git", "worktree", "remove"];
					if (force) {
						removeArgs.push("--force");
					}
					removeArgs.push(worktreePath);

					await withTimeout(
						runCommand(removeArgs, directory),
						15_000,
						"git worktree remove",
					);

					// Clean up DB
					const sessions = stateDB.listActive();
					for (const session of sessions) {
						if (session.branch === branch) {
							stateDB.removeSession(session.id);
						}
					}

					if (lifecycle?.current_worktree_path === worktreePath) {
						stateDB.leaveSession(lifecycle.current_session_id || "", true);
					}

					const snapshotNote = snapshotCommitted
						? " (changes snapshot-committed)"
						: shouldSnapshot && !hadDirtyChanges
							? " (no changes to snapshot)"
							: "";
					return `✅ Worktree deleted: ${relPath}${snapshotNote}\n📌 Branch "${branch}" still exists. Delete it with \`git branch -D ${branch}\` if no longer needed.`;
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return `❌ Failed to delete worktree: ${msg}`;
				}
			},
		}),
	};
}
