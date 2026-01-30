/**
 * Branch Manager - Git branch detection and management
 */

import { join } from "node:path";

export interface BranchCleanupResult {
	/** Branch that was cleaned up */
	branch: string;
	/** Number of symbols deleted */
	symbolsDeleted: number;
	/** Number of edges deleted */
	edgesDeleted: number;
	/** Number of files deleted */
	filesDeleted: number;
	/** Number of vectors deleted */
	vectorsDeleted: number;
	/** Number of keywords deleted */
	keywordsDeleted: number;
}

export interface BranchManager {
	/** Get current branch name */
	getCurrentBranch(): Promise<string>;

	/** Watch for branch changes */
	onBranchChange(callback: (newBranch: string) => void): () => void;

	/** Get default branch name */
	getDefaultBranch(): Promise<string>;

	/** Check if in a git repository */
	isGitRepo(): Promise<boolean>;

	/** List all local branches */
	listLocalBranches(): Promise<string[]>;

	/** List all branches that have indexed data */
	listIndexedBranches?(): string[];

	/** Clean up orphaned branch data (branches that no longer exist) */
	cleanupOrphanedBranches?(): Promise<BranchCleanupResult[]>;

	/** Delete all indexed data for a specific branch */
	deleteBranchData?(branch: string): BranchCleanupResult;
}

export function createBranchManager(workspaceRoot: string): BranchManager {
	let lastBranch: string | null = null;
	const listeners = new Set<(branch: string) => void>();
	let watchInterval: ReturnType<typeof setInterval> | null = null;

	async function readCurrentBranch(): Promise<string> {
		try {
			// Try reading .git/HEAD directly (fastest)
			const headPath = join(workspaceRoot, ".git", "HEAD");
			const headFile = Bun.file(headPath);

			if (await headFile.exists()) {
				const content = await headFile.text();
				const match = content.match(/^ref: refs\/heads\/(.+)/);
				if (match) {
					return match[1].trim();
				}
				// Detached HEAD - return short commit hash
				return content.trim().slice(0, 8);
			}

			// Fall back to git command
			const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: workspaceRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = await new Response(proc.stdout).text();
			await proc.exited;

			if (proc.exitCode === 0) {
				return output.trim();
			}
		} catch {
			// Not a git repo or other error
		}

		return "main"; // Default fallback
	}

	async function checkForBranchChange(): Promise<void> {
		const currentBranch = await readCurrentBranch();
		if (lastBranch !== null && currentBranch !== lastBranch) {
			for (const listener of listeners) {
				listener(currentBranch);
			}
		}
		lastBranch = currentBranch;
	}

	return {
		async getCurrentBranch(): Promise<string> {
			const branch = await readCurrentBranch();
			lastBranch = branch;
			return branch;
		},

		onBranchChange(callback: (newBranch: string) => void): () => void {
			listeners.add(callback);

			// Start watching if this is the first listener
			if (listeners.size === 1 && !watchInterval) {
				watchInterval = setInterval(checkForBranchChange, 2000);
			}

			// Return cleanup function
			return () => {
				listeners.delete(callback);
				if (listeners.size === 0 && watchInterval) {
					clearInterval(watchInterval);
					watchInterval = null;
				}
			};
		},

		async getDefaultBranch(): Promise<string> {
			try {
				// Try to get default branch from git config
				const proc = Bun.spawn(
					["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
					{
						cwd: workspaceRoot,
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const output = await new Response(proc.stdout).text();
				await proc.exited;

				if (proc.exitCode === 0) {
					const match = output.match(/refs\/remotes\/origin\/(.+)/);
					if (match) {
						return match[1].trim();
					}
				}
			} catch {
				// Ignore errors
			}

			return "main";
		},

		async isGitRepo(): Promise<boolean> {
			try {
				const gitDir = join(workspaceRoot, ".git");
				const file = Bun.file(gitDir);
				// Check if it's a directory (file.size will throw for directories)
				const proc = Bun.spawn(["test", "-d", gitDir], {
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
				return proc.exitCode === 0;
			} catch {
				return false;
			}
		},

		async listLocalBranches(): Promise<string[]> {
			try {
				const proc = Bun.spawn(
					["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
					{
						cwd: workspaceRoot,
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const output = await new Response(proc.stdout).text();
				await proc.exited;

				if (proc.exitCode === 0) {
					return output
						.trim()
						.split("\n")
						.filter((b) => b.length > 0);
				}
			} catch {
				// Ignore errors
			}
			return [];
		},
	};
}

/**
 * Extended Branch Manager with cleanup capabilities
 * Requires database access for cleanup operations
 */
export interface BranchCleanupStore {
	deleteSymbolsByBranch(branch: string): number;
	deleteEdgesByBranch(branch: string): number;
	deleteFilesByBranch(branch: string): number;
	deleteVectorsByBranch(branch: string): number;
	deleteKeywordsByBranch(branch: string): number;
	listIndexedBranches(): string[];
}

export function createBranchManagerWithCleanup(
	workspaceRoot: string,
	store: BranchCleanupStore,
): BranchManager {
	const baseBranchManager = createBranchManager(workspaceRoot);

	return {
		...baseBranchManager,

		listIndexedBranches(): string[] {
			return store.listIndexedBranches();
		},

		deleteBranchData(branch: string): BranchCleanupResult {
			const symbolsDeleted = store.deleteSymbolsByBranch(branch);
			const edgesDeleted = store.deleteEdgesByBranch(branch);
			const filesDeleted = store.deleteFilesByBranch(branch);
			const vectorsDeleted = store.deleteVectorsByBranch(branch);
			const keywordsDeleted = store.deleteKeywordsByBranch(branch);

			return {
				branch,
				symbolsDeleted,
				edgesDeleted,
				filesDeleted,
				vectorsDeleted,
				keywordsDeleted,
			};
		},

		async cleanupOrphanedBranches(): Promise<BranchCleanupResult[]> {
			const localBranches = new Set(await baseBranchManager.listLocalBranches());
			const indexedBranches = store.listIndexedBranches();
			const results: BranchCleanupResult[] = [];

			for (const branch of indexedBranches) {
				// Skip if branch still exists locally
				if (localBranches.has(branch)) {
					continue;
				}

				// Delete orphaned branch data
				const result = this.deleteBranchData!(branch);
				if (
					result.symbolsDeleted > 0 ||
					result.edgesDeleted > 0 ||
					result.filesDeleted > 0
				) {
					results.push(result);
				}
			}

			return results;
		},
	};
}
