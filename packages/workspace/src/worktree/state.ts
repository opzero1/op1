/**
 * Worktree State Management
 *
 * Uses SQLite (via bun:sqlite) to track worktree sessions, branches,
 * and pending operations. State stored at:
 *   ~/.local/share/op1/{projectId}/worktrees.db
 */

import { Database } from "bun:sqlite";
import { homedir, join, mkdir } from "../bun-compat.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface WorktreeSession {
	id: string;
	worktree_path: string;
	branch: string;
	created_at: string;
	status: "active" | "pending_delete";
}

export interface PendingOperation {
	session_id: string;
	operation: "snapshot" | "delete";
	created_at: string;
}

export interface WorktreeLifecycleState {
	current_session_id: string | null;
	current_worktree_path: string | null;
	last_entered_at: string | null;
	last_left_at: string | null;
	updated_at: string;
}

// ──────────────────────────────────────────────
// Database Manager
// ──────────────────────────────────────────────

/**
 * Create and initialize the worktree state database.
 * Returns a set of operations for managing worktree state.
 */
export async function createWorktreeDB(projectId: string) {
	const baseDir = join(homedir(), ".local", "share", "op1", projectId);
	await mkdir(baseDir, { recursive: true });

	const dbPath = join(baseDir, "worktrees.db");
	const db = new Database(dbPath);

	// Enable WAL mode for better concurrent access
	db.run("PRAGMA journal_mode = WAL");

	// Create tables
	db.run(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			worktree_path TEXT NOT NULL,
			branch TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			status TEXT NOT NULL DEFAULT 'active'
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS pending_operations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lifecycle_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			current_session_id TEXT,
			current_worktree_path TEXT,
			last_entered_at TEXT,
			last_left_at TEXT,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	db.run(`
		INSERT OR IGNORE INTO lifecycle_state (id)
		VALUES (1)
	`);

	// Prepared statements
	const insertSession = db.prepare(`
		INSERT INTO sessions (id, worktree_path, branch, created_at, status)
		VALUES (?, ?, ?, datetime('now'), 'active')
	`);

	const getSession = db.prepare(`
		SELECT * FROM sessions WHERE id = ?
	`);

	const listActiveSessions = db.prepare(`
		SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC
	`);

	const updateStatus = db.prepare(`
		UPDATE sessions SET status = ? WHERE id = ?
	`);

	const deleteSession = db.prepare(`
		DELETE FROM sessions WHERE id = ?
	`);

	const insertPendingOp = db.prepare(`
		INSERT INTO pending_operations (session_id, operation) VALUES (?, ?)
	`);

	const listPendingOps = db.prepare(`
		SELECT * FROM pending_operations ORDER BY created_at ASC
	`);

	const deletePendingOps = db.prepare(`
		DELETE FROM pending_operations WHERE session_id = ?
	`);

	const selectLifecycleState = db.prepare(`
		SELECT
			current_session_id,
			current_worktree_path,
			last_entered_at,
			last_left_at,
			updated_at
		FROM lifecycle_state
		WHERE id = 1
	`);

	const enterLifecycleState = db.prepare(`
		UPDATE lifecycle_state
		SET
			current_session_id = ?,
			current_worktree_path = ?,
			last_entered_at = datetime('now'),
			updated_at = datetime('now')
		WHERE id = 1
	`);

	const leaveLifecycleState = db.prepare(`
		UPDATE lifecycle_state
		SET
			current_session_id = NULL,
			current_worktree_path = NULL,
			last_left_at = datetime('now'),
			updated_at = datetime('now')
		WHERE id = 1
	`);

	return {
		addSession(id: string, worktreePath: string, branch: string) {
			insertSession.run(id, worktreePath, branch);
		},

		getSession(id: string): WorktreeSession | null {
			return (getSession.get(id) as WorktreeSession) ?? null;
		},

		listActive(): WorktreeSession[] {
			return listActiveSessions.all() as WorktreeSession[];
		},

		markPendingDelete(id: string) {
			updateStatus.run("pending_delete", id);
			insertPendingOp.run(id, "delete");
		},

		removeSession(id: string) {
			deletePendingOps.run(id);
			deleteSession.run(id);

			const lifecycle = selectLifecycleState.get() as
				| WorktreeLifecycleState
				| undefined;
			if (lifecycle?.current_session_id === id) {
				leaveLifecycleState.run();
			}
		},

		addPendingOperation(sessionId: string, operation: "snapshot" | "delete") {
			insertPendingOp.run(sessionId, operation);
		},

		listPendingOperations(): PendingOperation[] {
			return listPendingOps.all() as PendingOperation[];
		},

		clearPendingOperations(sessionId: string) {
			deletePendingOps.run(sessionId);
		},

		enterSession(sessionId: string) {
			const session = getSession.get(sessionId) as WorktreeSession | undefined;
			if (!session) {
				throw new Error(`Worktree session not found: ${sessionId}`);
			}

			enterLifecycleState.run(session.id, session.worktree_path);
		},

		leaveSession(sessionId: string, force: boolean = false): boolean {
			const lifecycle = selectLifecycleState.get() as
				| WorktreeLifecycleState
				| undefined;
			if (!lifecycle) {
				return false;
			}

			if (!force && lifecycle.current_session_id !== sessionId) {
				return false;
			}

			if (!lifecycle.current_session_id) {
				return false;
			}

			leaveLifecycleState.run();
			return true;
		},

		getLifecycleState(): WorktreeLifecycleState | null {
			return (selectLifecycleState.get() as WorktreeLifecycleState) ?? null;
		},

		close() {
			db.close();
		},
	};
}

export type WorktreeDB = Awaited<ReturnType<typeof createWorktreeDB>>;
