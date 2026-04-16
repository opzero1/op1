/**
 * Worktree Module — Public API
 *
 * Re-exports the worktree tool factories for use by the workspace plugin.
 */

export {
	executeWorktreeCleanup,
	isDirtyWorktree,
	parseWorktreeList,
	type WorktreeBranchAction,
	type WorktreeCleanupInput,
	type WorktreeCleanupResult,
	type WorktreeListEntry,
} from "./operations.js";
export {
	escapeAppleScript,
	escapeShell,
	FileMutex,
	sanitizeBranchName,
	withTimeout,
} from "./primitives.js";
export {
	createWorktreeDB,
	type WorktreeDB,
	type WorktreeLifecycleState,
	type WorktreeSession,
} from "./state.js";
export { spawnTerminal } from "./terminal.js";
export { createWorktreeTools } from "./tools.js";
