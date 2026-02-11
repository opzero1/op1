/**
 * Worktree Lifecycle Tools
 *
 * Plugin tools for creating, listing, and deleting git worktrees.
 * Each session gets its own worktree for isolated development.
 */

import { tool } from "@opencode-ai/plugin";
import { mkdir, readdir, copyFile, symlink, stat } from "fs/promises";
import { join, relative, basename } from "path";

import { runCommand, isSystemError } from "../utils.js";
import { sanitizeBranchName, withTimeout } from "./primitives.js";
import { createWorktreeDB, type WorktreeDB } from "./state.js";
import { spawnTerminal } from "./terminal.js";

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

// ──────────────────────────────────────────────
// Tool Definitions
// ──────────────────────────────────────────────

export function createWorktreeTools(
	directory: string,
	projectId: string,
) {
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
					.describe("Branch name for the worktree (will be created if it doesn't exist)"),
				base: tool.schema
					.string()
					.optional()
					.describe("Base branch to create from (default: current branch)"),
				open_terminal: tool.schema
					.boolean()
					.optional()
					.describe("Whether to open a terminal in the worktree (default: true)"),
			},
			async execute(args, toolCtx) {
				if (!toolCtx?.sessionID) {
					return "❌ worktree_create requires sessionID.";
				}

				const sanitized = sanitizeBranchName(args.branch);
				if (!sanitized) {
					return `❌ Invalid branch name: "${args.branch}". Use alphanumeric characters, dashes, dots, or slashes.`;
				}

				const worktreeBase = getWorktreeBase();
				await mkdir(worktreeBase, { recursive: true });

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
					const copied = await copyFiles(directory, worktreePath, DEFAULT_CONFIG.copy);
					const linked = await createSymlinks(directory, worktreePath, DEFAULT_CONFIG.symlinks);

					// Track in database
					const stateDB = await getDB();
					stateDB.addSession(toolCtx.sessionID, worktreePath, sanitized);

					// Open terminal if requested
					const openTerminal = args.open_terminal !== false;
					let terminalInfo = "";
					if (openTerminal) {
						try {
							const result = await spawnTerminal(worktreePath, sanitized, projectId);
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
					if (copied.length > 0) details.push(`📋 Copied: ${copied.join(", ")}`);
					if (linked.length > 0) details.push(`🔗 Symlinked: ${linked.join(", ")}`);
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

					// Parse porcelain output
					const worktrees: Array<{ path: string; head: string; branch: string }> = [];
					let current: Partial<{ path: string; head: string; branch: string }> = {};

					for (const line of output.split("\n")) {
						if (line.startsWith("worktree ")) {
							if (current.path) worktrees.push(current as { path: string; head: string; branch: string });
							current = { path: line.slice(9) };
						} else if (line.startsWith("HEAD ")) {
							current.head = line.slice(5, 12); // Short SHA
						} else if (line.startsWith("branch ")) {
							current.branch = line.slice(7).replace("refs/heads/", "");
						}
					}
					if (current.path) worktrees.push(current as { path: string; head: string; branch: string });

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
			},
			async execute(args) {
				const branch = args.branch.trim();
				const shouldSnapshot = args.snapshot !== false;

				try {
					// Find the worktree path
					const output = await runCommand(
						["git", "worktree", "list", "--porcelain"],
						directory,
					);

					let worktreePath: string | null = null;
					let currentPath: string | null = null;

					for (const line of output.split("\n")) {
						if (line.startsWith("worktree ")) {
							currentPath = line.slice(9);
						} else if (line.startsWith("branch ")) {
							const branchName = line.slice(7).replace("refs/heads/", "");
							if (branchName === branch) {
								worktreePath = currentPath;
							}
						}
					}

					if (!worktreePath) {
						return `❌ No worktree found for branch "${branch}".`;
					}

					// Don't allow deleting the main worktree
					const relPath = relative(directory, worktreePath);
					if (relPath === "" || relPath === ".") {
						return "❌ Cannot delete the main worktree.";
					}

					// Snapshot uncommitted changes before deletion
					if (shouldSnapshot) {
						try {
							const status = await runCommand(
								["git", "status", "--porcelain"],
								worktreePath,
							);
							if (status.trim()) {
								await runCommand(["git", "add", "-A"], worktreePath);
								await runCommand(
									["git", "commit", "-m", `snapshot: auto-save before worktree deletion [${branch}]`],
									worktreePath,
								);
							}
						} catch {
							// Snapshot is best-effort
						}
					}

					// Remove worktree
					await withTimeout(
						runCommand(["git", "worktree", "remove", "--force", worktreePath], directory),
						15_000,
						"git worktree remove",
					);

					// Clean up DB
					const stateDB = await getDB();
					const sessions = stateDB.listActive();
					for (const session of sessions) {
						if (session.branch === branch) {
							stateDB.removeSession(session.id);
						}
					}

					const snapshotNote = shouldSnapshot ? " (changes snapshot-committed)" : "";
					return `✅ Worktree deleted: ${relPath}${snapshotNote}\n📌 Branch "${branch}" still exists. Delete it with \`git branch -D ${branch}\` if no longer needed.`;
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return `❌ Failed to delete worktree: ${msg}`;
				}
			},
		}),
	};
}
