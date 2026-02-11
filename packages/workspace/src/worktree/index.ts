/**
 * Worktree Module — Public API
 *
 * Re-exports the worktree tool factories for use by the workspace plugin.
 */

export { createWorktreeTools } from "./tools.js";
export { createWorktreeDB, type WorktreeDB, type WorktreeSession } from "./state.js";
export { FileMutex, escapeShell, escapeAppleScript, sanitizeBranchName, withTimeout } from "./primitives.js";
export { spawnTerminal } from "./terminal.js";
