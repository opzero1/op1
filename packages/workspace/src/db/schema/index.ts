/**
 * Database schema barrel export
 *
 * All table definitions for the workspace database.
 * Matches ADR-0002 v1 relational schema contract.
 */

// NOTE: extensionless imports required for drizzle-kit CJS compatibility.
// Bun's bundler resolves these fine with moduleResolution: "bundler".
export { projectScopes } from "./project-scopes";
export { plans } from "./plans";
export { planSessions } from "./plan-sessions";
export { notepadEntries } from "./notepad-entries";
export { worktreeRefs } from "./worktree-refs";
