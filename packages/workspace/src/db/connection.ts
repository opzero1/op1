/**
 * Database Connection
 *
 * Opens a Bun SQLite database with production-ready pragmas and
 * returns a typed Drizzle instance. Composable: callers own the
 * lifecycle (open/close).
 *
 * Pragmas applied on every connection:
 *   - journal_mode = WAL        (concurrent reads during writes)
 *   - synchronous = NORMAL      (safe with WAL, better throughput)
 *   - foreign_keys = ON         (enforce FK constraints)
 *   - busy_timeout = 5000       (wait up to 5s on lock contention)
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema/index";

// ── Types ──────────────────────────────────────────────────

export type WorkspaceDb = BunSQLiteDatabase<typeof schema>;

export interface WorkspaceDbHandle {
	/** Typed Drizzle query interface */
	db: WorkspaceDb;
	/** Underlying Bun SQLite connection (for raw access or closing) */
	sqlite: Database;
	/** Close the database connection */
	close(): void;
}

export interface CreateWorkspaceDbOptions {
	/** Absolute path to the SQLite database file */
	dbPath: string;
}

// ── Pragmas ────────────────────────────────────────────────

const PRAGMAS: ReadonlyArray<string> = [
	"PRAGMA journal_mode = WAL;",
	"PRAGMA synchronous = NORMAL;",
	"PRAGMA foreign_keys = ON;",
	"PRAGMA busy_timeout = 5000;",
];

// ── Factory ────────────────────────────────────────────────

/**
 * Open a workspace SQLite database with production pragmas.
 *
 * The caller owns the returned handle and must call `close()`
 * when the database is no longer needed.
 *
 * @throws if the database file cannot be opened or created
 */
export function createWorkspaceDb(
	options: CreateWorkspaceDbOptions,
): WorkspaceDbHandle {
	const { dbPath } = options;

	const sqlite = new Database(dbPath, { create: true });

	for (const pragma of PRAGMAS) {
		sqlite.run(pragma);
	}

	const db = drizzle(sqlite, { schema });

	return {
		db,
		sqlite,
		close() {
			sqlite.close();
		},
	};
}
