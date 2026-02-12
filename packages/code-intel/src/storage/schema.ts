/**
 * SQLite Schema for @op1/code-intel
 *
 * Uses bun:sqlite with FTS5 for keyword search.
 * Vector search uses pure JS implementation (no sqlite-vec required).
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Current schema version - increment when schema changes
export const SCHEMA_VERSION = 3;

// Default model ID — actual model is determined at runtime by createAutoEmbedder()
export const DEFAULT_EMBEDDING_MODEL_ID = "microsoft/unixcoder-base";
// Maximum supported embedding dimensions (for schema purposes)
export const MAX_EMBEDDING_DIMENSIONS = 1024;

// ============================================================================
// Schema SQL
// ============================================================================

const SCHEMA_SQL = `
-- Enable WAL mode for concurrent reads
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Schema metadata for versioning
CREATE TABLE IF NOT EXISTS schema_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Symbols table (nodes in the code graph)
CREATE TABLE IF NOT EXISTS symbols (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    type TEXT NOT NULL,
    language TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    signature TEXT,
    docstring TEXT,
    content_hash TEXT NOT NULL,
    is_external INTEGER NOT NULL DEFAULT 0,
    branch TEXT NOT NULL,
    embedding_model_id TEXT,
    updated_at INTEGER NOT NULL,
    revision_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_branch ON symbols(branch);
CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file_branch ON symbols(file_path, branch);

-- Edges table (relationships between symbols)
CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    origin TEXT NOT NULL,
    branch TEXT NOT NULL,
    source_start_line INTEGER,
    source_end_line INTEGER,
    target_start_line INTEGER,
    target_end_line INTEGER,
    updated_at INTEGER NOT NULL,
    metadata TEXT,
    FOREIGN KEY (source_id) REFERENCES symbols(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_branch ON edges(branch);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

-- Files table (file metadata and indexing status)
CREATE TABLE IF NOT EXISTS files (
    file_path TEXT PRIMARY KEY,
    file_hash TEXT NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    last_indexed INTEGER NOT NULL,
    language TEXT NOT NULL,
    branch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    symbol_count INTEGER NOT NULL DEFAULT 0,
    importance_rank REAL,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_branch ON files(branch);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

-- Repo map table (file importance rankings per branch)
CREATE TABLE IF NOT EXISTS repo_map (
    file_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    importance_score REAL NOT NULL,
    in_degree INTEGER NOT NULL DEFAULT 0,
    out_degree INTEGER NOT NULL DEFAULT 0,
    symbol_summary TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (file_path, branch)
);

CREATE INDEX IF NOT EXISTS idx_repo_map_branch_score ON repo_map(branch, importance_score DESC);

-- FTS5 table for keyword search with trigram tokenizer
CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
    symbol_id,
    name,
    qualified_name,
    content,
    file_path,
    tokenize = 'trigram'
);

-- Pure JS vector store table (no sqlite-vec extension required)
CREATE TABLE IF NOT EXISTS js_vectors (
    symbol_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    granularity TEXT NOT NULL DEFAULT 'symbol',
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_js_vectors_granularity ON js_vectors(granularity);

-- Chunks table (for multi-granularity indexing)
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    parent_symbol_id TEXT,
    language TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    branch TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (parent_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_branch ON chunks(branch);
CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_symbol_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file_branch ON chunks(file_path, branch);

-- File contents table (for file-level search)
CREATE TABLE IF NOT EXISTS file_contents (
    file_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (file_path, branch)
);

CREATE INDEX IF NOT EXISTS idx_file_contents_branch ON file_contents(branch);

-- Unified FTS5 table for multi-granularity keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
    content_id,
    content_type,
    file_path,
    name,
    content,
    tokenize = 'trigram'
);
`;

// ============================================================================
// Migration definitions
// ============================================================================

interface Migration {
	version: number;
	description: string;
	sql: string;
}

const MIGRATIONS: Migration[] = [
	// Version 1 is the initial schema - no migration needed
	// Version 2: Multi-granularity indexing support
	{
		version: 2,
		description: "Add multi-granularity indexing tables (chunks, file_contents, fts_content)",
		sql: `
			-- Add granularity column to js_vectors
			ALTER TABLE js_vectors ADD COLUMN granularity TEXT NOT NULL DEFAULT 'symbol';
			CREATE INDEX IF NOT EXISTS idx_js_vectors_granularity ON js_vectors(granularity);

			-- Chunks table
			CREATE TABLE IF NOT EXISTS chunks (
				id TEXT PRIMARY KEY,
				file_path TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				content TEXT NOT NULL,
				chunk_type TEXT NOT NULL,
				parent_symbol_id TEXT,
				language TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				branch TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (parent_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
			CREATE INDEX IF NOT EXISTS idx_chunks_branch ON chunks(branch);
			CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_symbol_id);
			CREATE INDEX IF NOT EXISTS idx_chunks_file_branch ON chunks(file_path, branch);

			-- File contents table
			CREATE TABLE IF NOT EXISTS file_contents (
				file_path TEXT NOT NULL,
				branch TEXT NOT NULL,
				content TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				language TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (file_path, branch)
			);
			CREATE INDEX IF NOT EXISTS idx_file_contents_branch ON file_contents(branch);

			-- Unified FTS5 table
			CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
				content_id,
				content_type,
				file_path,
				name,
				content,
				tokenize = 'trigram'
			);
		`,
	},
	// Version 3: Voyage AI embedder support
	{
		version: 3,
		description: "Voyage AI embedder support — wipe vectors for dimension change",
		sql: `
			-- Wipe all vectors since dimensions may have changed
			DELETE FROM js_vectors;
			-- Drop and recreate vec_symbols if it exists (sqlite-vec)
			DROP TABLE IF EXISTS vec_symbols;
		`,
	},
];

// ============================================================================
// Schema Manager
// ============================================================================

export interface SchemaManager {
	db: Database;
	initialize(): Promise<void>;
	getCurrentVersion(): number;
	runMigrations(): Promise<void>;
	getEmbeddingModelId(): string | null;
	setEmbeddingModelId(modelId: string): void;
	needsReembedding(modelId: string): boolean;
	wipeVectorsForModelChange(newModelId: string): void;
	close(): void;
}

export async function createSchemaManager(
	dbPath: string,
): Promise<SchemaManager> {
	// Ensure directory exists
	const dir = dirname(dbPath);
	await mkdir(dir, { recursive: true });

	// Open database (no custom SQLite, no extensions - pure bun:sqlite)
	const db = new Database(dbPath);

	function getCurrentVersion(): number {
		try {
			const result = db
				.prepare(
					"SELECT value FROM schema_metadata WHERE key = 'schema_version'",
				)
				.get() as { value: string } | null;
			return result ? Number.parseInt(result.value, 10) : 0;
		} catch {
			// Table doesn't exist yet
			return 0;
		}
	}

	function getEmbeddingModelId(): string | null {
		try {
			const result = db
				.prepare(
					"SELECT value FROM schema_metadata WHERE key = 'embedding_model_id'",
				)
				.get() as { value: string } | null;
			return result?.value ?? null;
		} catch {
			return null;
		}
	}

	function setEmbeddingModelId(modelId: string): void {
		db.prepare(
			"INSERT OR REPLACE INTO schema_metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
		).run("embedding_model_id", modelId);
	}

	function needsReembedding(modelId: string): boolean {
		const current = getEmbeddingModelId();
		return current !== null && current !== modelId;
	}

	function wipeVectorsForModelChange(newModelId: string): void {
		db.exec("DELETE FROM js_vectors");
		db.exec("DROP TABLE IF EXISTS vec_symbols");
		setEmbeddingModelId(newModelId);
	}

	async function runMigrations(): Promise<void> {
		const currentVersion = getCurrentVersion();

		for (const migration of MIGRATIONS) {
			if (migration.version > currentVersion) {
				db.exec(migration.sql);
				db.prepare(
					"INSERT OR REPLACE INTO schema_metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
				).run("schema_version", String(migration.version));
			}
		}
	}

	async function initialize(): Promise<void> {
		// Create base schema (includes js_vectors table for pure JS vector store)
		db.exec(SCHEMA_SQL);

		// Initialize schema metadata if not exists
		const currentVersion = getCurrentVersion();
		if (currentVersion === 0) {
			db.prepare(
				"INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)",
			).run("schema_version", String(SCHEMA_VERSION));
		}

		// Run migrations if needed
		await runMigrations();
	}

	function close(): void {
		db.close();
	}

	return {
		db,
		initialize,
		getCurrentVersion,
		runMigrations,
		getEmbeddingModelId,
		setEmbeddingModelId,
		needsReembedding,
		wipeVectorsForModelChange,
		close,
	};
}
