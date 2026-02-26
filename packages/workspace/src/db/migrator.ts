/**
 * Database Migrator
 *
 * Runs Drizzle migrations from the bundled migration folder.
 * Designed to be called during plugin startup before any
 * database queries execute.
 */

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { WorkspaceDbHandle } from "./connection";

// ── Types ──────────────────────────────────────────────────

export interface MigrateOptions {
	/** Override the migrations folder path (defaults to package migration/) */
	migrationsFolder?: string;
}

// ── Migration runner ───────────────────────────────────────

/**
 * Resolve the default migrations folder relative to this file.
 *
 * At runtime the compiled JS lives in dist/, so we walk up to
 * the package root and into migration/.
 */
function resolveDefaultMigrationsFolder(): string {
	const thisDir = dirname(fileURLToPath(import.meta.url));
	// From dist/db/ or src/db/ -> package root -> migration/
	return join(thisDir, "..", "..", "migration");
}

/**
 * Apply all pending Drizzle migrations to the workspace database.
 *
 * @throws if any migration fails (Drizzle rolls back automatically)
 */
export function runMigrations(
	handle: WorkspaceDbHandle,
	options?: MigrateOptions,
): void {
	const migrationsFolder =
		options?.migrationsFolder ?? resolveDefaultMigrationsFolder();

	migrate(handle.db, { migrationsFolder });
}
