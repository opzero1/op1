import { relative } from "../bun-compat.js";
import { getProjectId, runCommand } from "../utils.js";
import { withTimeout } from "./primitives.js";
import { createWorktreeDB, type WorktreeDB } from "./state.js";

export interface WorktreeListEntry {
	path: string;
	head: string;
	branch: string;
}

export type WorktreeBranchAction = "keep" | "delete_safe";

export interface WorktreeCleanupInput {
	directory: string;
	branch: string;
	worktreePath?: string;
	snapshot?: boolean;
	force?: boolean;
	branchAction?: WorktreeBranchAction;
	stateDB?: WorktreeDB;
}

export interface WorktreeCleanupResult {
	ok: boolean;
	branch: string;
	worktreePath?: string;
	relativePath?: string;
	snapshotRequested: boolean;
	snapshotCommitted: boolean;
	hadDirtyChanges: boolean;
	branchAction: WorktreeBranchAction;
	branchDeleted: boolean;
	branchDeleteError?: string;
	error?: string;
}

export function parseWorktreeList(output: string): WorktreeListEntry[] {
	const worktrees: WorktreeListEntry[] = [];
	let current: Partial<WorktreeListEntry> = {};

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) {
				worktrees.push(current as WorktreeListEntry);
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
		worktrees.push(current as WorktreeListEntry);
	}

	return worktrees;
}

export async function isDirtyWorktree(worktreePath: string): Promise<boolean> {
	const status = await runCommand(
		["git", "status", "--porcelain"],
		worktreePath,
	);
	return status.trim().length > 0;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function executeWorktreeCleanup(
	input: WorktreeCleanupInput,
): Promise<WorktreeCleanupResult> {
	const branch = input.branch.trim();
	const shouldSnapshot = input.snapshot !== false;
	const force = input.force === true;
	const branchAction = input.branchAction ?? "keep";
	let snapshotCommitted = false;
	let hadDirtyChanges = false;
	let resolvedWorktreePath = input.worktreePath?.trim() || undefined;
	let relativePath: string | undefined;
	let ownedStateDB: WorktreeDB | null = null;

	const finalize = (
		patch: Partial<WorktreeCleanupResult>,
	): WorktreeCleanupResult => ({
		ok: patch.ok ?? false,
		branch,
		worktreePath: resolvedWorktreePath,
		relativePath,
		snapshotRequested: shouldSnapshot,
		snapshotCommitted,
		hadDirtyChanges,
		branchAction,
		branchDeleted: patch.branchDeleted ?? false,
		branchDeleteError: patch.branchDeleteError,
		error: patch.error,
	});

	if (!branch) {
		return finalize({ error: "Branch name is required for worktree cleanup." });
	}

	try {
		if (!input.stateDB) {
			ownedStateDB = await createWorktreeDB(
				await getProjectId(input.directory),
			);
		}
		const stateDB = input.stateDB ?? ownedStateDB;
		if (!stateDB) {
			return finalize({
				error: "Worktree cleanup could not open state storage.",
			});
		}

		if (!resolvedWorktreePath) {
			const output = await runCommand(
				["git", "worktree", "list", "--porcelain"],
				input.directory,
			);
			const matched = parseWorktreeList(output).find(
				(item) => item.branch === branch,
			);
			resolvedWorktreePath = matched?.path;
		}

		if (!resolvedWorktreePath) {
			return finalize({ error: `No worktree found for branch "${branch}".` });
		}

		relativePath = relative(input.directory, resolvedWorktreePath);
		if (relativePath === "" || relativePath === ".") {
			return finalize({ error: "Cannot delete the main worktree." });
		}

		const lifecycle = stateDB.getLifecycleState();
		if (lifecycle?.current_worktree_path === resolvedWorktreePath && !force) {
			return finalize({
				error:
					"Cannot delete currently entered worktree context. Leave it first or use force=true.",
			});
		}

		if (shouldSnapshot) {
			const statusWithIgnored = await runCommand(
				["git", "status", "--porcelain", "--ignored"],
				resolvedWorktreePath,
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
				return finalize({
					error:
						"Worktree has ignored files that cannot be snapshotted. Deletion aborted. Use force=true to delete anyway.",
				});
			}

			if (hadDirtyChanges) {
				try {
					await runCommand(["git", "add", "-A"], resolvedWorktreePath);
					await runCommand(
						[
							"git",
							"commit",
							"-m",
							`snapshot: auto-save before worktree deletion [${branch}]`,
						],
						resolvedWorktreePath,
					);
					snapshotCommitted = true;
				} catch (error) {
					return finalize({
						error: `Failed to snapshot changes before deletion: ${toErrorMessage(error)}`,
					});
				}

				const postCommitStatus = await runCommand(
					["git", "status", "--porcelain"],
					resolvedWorktreePath,
				);
				if (postCommitStatus.trim().length > 0) {
					return finalize({
						error:
							"Snapshot verification failed: worktree still has pending changes. Deletion aborted.",
					});
				}
			}
		}

		const removeArgs = ["git", "worktree", "remove"];
		if (force) {
			removeArgs.push("--force");
		}
		removeArgs.push(resolvedWorktreePath);

		await withTimeout(
			runCommand(removeArgs, input.directory),
			15_000,
			"git worktree remove",
		);

		const sessions = stateDB.listActive();
		for (const session of sessions) {
			if (
				session.branch === branch ||
				session.worktree_path === resolvedWorktreePath
			) {
				stateDB.removeSession(session.id);
			}
		}

		if (lifecycle?.current_worktree_path === resolvedWorktreePath) {
			stateDB.leaveSession(lifecycle.current_session_id || "", true);
		}

		let branchDeleted = false;
		let branchDeleteError: string | undefined;
		if (branchAction === "delete_safe") {
			try {
				await runCommand(["git", "branch", "-d", branch], input.directory);
				branchDeleted = true;
			} catch (error) {
				branchDeleteError = toErrorMessage(error);
			}
		}

		return finalize({ ok: true, branchDeleted, branchDeleteError });
	} catch (error) {
		return finalize({
			error: `Failed to delete worktree: ${toErrorMessage(error)}`,
		});
	} finally {
		ownedStateDB?.close();
	}
}
