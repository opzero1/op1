/**
 * Database module public API
 *
 * Re-exports connection lifecycle, migrator, and schema for
 * consumers that need typed database access.
 */

// Connection lifecycle
export {
	createWorkspaceDb,
	type WorkspaceDb,
	type WorkspaceDbHandle,
	type CreateWorkspaceDbOptions,
} from "./connection";

// Migration runner
export { runMigrations, type MigrateOptions } from "./migrator";

// Schema (for typed queries)
export * as schema from "./schema/index";
