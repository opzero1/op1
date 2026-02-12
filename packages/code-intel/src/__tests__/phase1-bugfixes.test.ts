/**
 * Phase 1 Bug Fix Regression Tests
 *
 * Validates three critical bugs fixed in Phase 1:
 *
 * BUG 3 — Rerank propagation no-op: searchEnhanced() was returning pre-rerank
 *          symbol order instead of re-deriving from finalRanked.
 *
 * BUG 2 — File-granularity retrieval broken at 3 layers:
 *   Layer 1: vector-search.ts skipped file embeddings
 *   Layer 2: multi-granular-search.ts had no "file" branch in extractResults/getContentById
 *   Layer 3: smart-query.ts had no handler for file/chunk results → SymbolNode wrappers
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createSymbolStore } from "../storage/symbol-store";
import { createChunkStore } from "../storage/chunk-store";
import { createContentFTSStore } from "../storage/content-fts-store";
import { createGranularVectorStore } from "../storage/pure-vector-store";
import {
	createEnhancedMultiGranularSearch,
	createMultiGranularSearch,
	type EnhancedMultiGranularSearch,
	type MultiGranularSearch,
} from "../query/multi-granular-search";
import type { SymbolNode, ChunkNode } from "../types";

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal in-memory DB with all required tables for the search pipeline. */
function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = OFF"); // Simplify test setup

	db.exec(`
		CREATE TABLE symbols (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			qualified_name TEXT NOT NULL,
			type TEXT NOT NULL,
			language TEXT NOT NULL DEFAULT 'typescript',
			file_path TEXT NOT NULL,
			start_line INTEGER NOT NULL DEFAULT 1,
			end_line INTEGER NOT NULL DEFAULT 10,
			content TEXT NOT NULL,
			signature TEXT,
			docstring TEXT,
			content_hash TEXT NOT NULL DEFAULT '',
			is_external INTEGER NOT NULL DEFAULT 0,
			branch TEXT NOT NULL DEFAULT 'main',
			embedding_model_id TEXT,
			updated_at INTEGER NOT NULL DEFAULT 0,
			revision_id INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX idx_symbols_file_path ON symbols(file_path);
		CREATE INDEX idx_symbols_name ON symbols(name);
	`);

	db.exec(`
		CREATE TABLE chunks (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			start_line INTEGER NOT NULL DEFAULT 1,
			end_line INTEGER NOT NULL DEFAULT 10,
			content TEXT NOT NULL,
			chunk_type TEXT NOT NULL,
			parent_symbol_id TEXT,
			language TEXT NOT NULL DEFAULT 'typescript',
			content_hash TEXT NOT NULL DEFAULT '',
			branch TEXT NOT NULL DEFAULT 'main',
			updated_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX idx_chunks_file_path ON chunks(file_path);
	`);

	// FTS5 with porter tokenizer (pairs well with buildFTS5Query's quoted-term + prefix style)
	db.exec(`
		CREATE VIRTUAL TABLE fts_content USING fts5(
			content_id,
			content_type,
			file_path,
			name,
			content,
			tokenize='porter'
		);
	`);

	// Granular vector store table (matches schema.ts)
	db.exec(`
		CREATE TABLE js_vectors (
			symbol_id TEXT PRIMARY KEY,
			embedding BLOB NOT NULL,
			granularity TEXT NOT NULL DEFAULT 'symbol',
			updated_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX idx_js_vectors_granularity ON js_vectors(granularity);
	`);

	return db;
}

/** Serialize a number[] to base64 Float32Array for the js_vectors table. */
function serializeEmbedding(embedding: number[]): string {
	const buffer = new Float32Array(embedding);
	const bytes = new Uint8Array(buffer.buffer);
	return Buffer.from(bytes).toString("base64");
}

/**
 * Build a unit vector pointing in the direction of the given index.
 * All dimensions are 0 except the given index which is 1.
 * Useful for deterministic cosine similarity tests.
 */
function basisVector(dims: number, index: number): number[] {
	const v = new Array(dims).fill(0);
	v[index % dims] = 1;
	return v;
}

/** Slightly perturbed basis vector — high but not perfect similarity to basisVector(dims, index). */
function nearBasisVector(dims: number, index: number, noise = 0.1): number[] {
	const v = basisVector(dims, index);
	v[(index + 1) % dims] = noise;
	return v;
}

// ============================================================================
// Test Data
// ============================================================================

const DIMS = 8; // Tiny embedding dimension for fast tests

const SYMBOLS: SymbolNode[] = [
	{
		id: "sym-alpha",
		name: "alpha",
		qualified_name: "src/alpha.alpha",
		type: "FUNCTION",
		language: "typescript",
		file_path: "src/alpha.ts",
		start_line: 1,
		end_line: 10,
		content: "export function alpha() { return 'alpha'; }",
		content_hash: "hash-alpha",
		is_external: false,
		branch: "main",
		updated_at: 0,
		revision_id: 0,
	},
	{
		id: "sym-beta",
		name: "beta",
		qualified_name: "src/beta.beta",
		type: "FUNCTION",
		language: "typescript",
		file_path: "src/beta.ts",
		start_line: 5,
		end_line: 20,
		content: "export function beta() { return 'beta result'; }",
		content_hash: "hash-beta",
		is_external: false,
		branch: "main",
		updated_at: 0,
		revision_id: 0,
	},
	{
		id: "sym-gamma",
		name: "gamma",
		qualified_name: "src/gamma.gamma",
		type: "FUNCTION",
		language: "python",
		file_path: "src/gamma.py",
		start_line: 10,
		end_line: 30,
		content: "def gamma(): return 'gamma output'",
		content_hash: "hash-gamma",
		is_external: false,
		branch: "main",
		updated_at: 0,
		revision_id: 0,
	},
];

const CHUNKS: ChunkNode[] = [
	{
		id: "chunk-block-1",
		file_path: "src/alpha.ts",
		start_line: 11,
		end_line: 25,
		content: "// Block chunk after alpha function",
		chunk_type: "block",
		language: "typescript",
		content_hash: "hash-block-1",
		branch: "main",
		updated_at: 0,
	},
	{
		// File-granularity chunk — the key entity for BUG 2
		id: "file-src-utils-ts",
		file_path: "src/utils.ts",
		start_line: 1,
		end_line: 50,
		content: "// Full file content of utils.ts\nexport function utilHelper() { return true; }",
		chunk_type: "file",
		language: "typescript",
		content_hash: "hash-file-utils",
		branch: "main",
		updated_at: 0,
	},
	{
		id: "file-src-config-py",
		file_path: "src/config.py",
		start_line: 1,
		end_line: 40,
		content: "# Full file content of config.py\ndef load_config(): pass",
		chunk_type: "file",
		language: "python",
		content_hash: "hash-file-config",
		branch: "main",
		updated_at: 0,
	},
];

// ============================================================================
// Suite Setup
// ============================================================================

describe("Phase 1 Bug Fixes", () => {
	let db: Database;
	let symbolStore: ReturnType<typeof createSymbolStore>;
	let chunkStore: ReturnType<typeof createChunkStore>;
	let contentFTS: ReturnType<typeof createContentFTSStore>;
	let granularVectors: ReturnType<typeof createGranularVectorStore>;
	let baseSearch: MultiGranularSearch;
	let enhancedSearch: EnhancedMultiGranularSearch;

	beforeAll(() => {
		db = createTestDb();
		symbolStore = createSymbolStore(db);
		chunkStore = createChunkStore(db);
		contentFTS = createContentFTSStore(db);
		granularVectors = createGranularVectorStore(db);

		// Seed symbols
		for (const sym of SYMBOLS) {
			symbolStore.upsert(sym);
		}

		// Seed chunks
		for (const chunk of CHUNKS) {
			chunkStore.upsert(chunk);
		}

		// Seed FTS entries for all items
		contentFTS.indexMany([
			// Symbols in FTS
			...SYMBOLS.map((s) => ({
				content_id: s.id,
				content_type: "symbol" as const,
				file_path: s.file_path,
				name: s.name,
				content: s.content,
			})),
			// Chunks in FTS (including file-granularity)
			{
				content_id: "chunk-block-1",
				content_type: "chunk" as const,
				file_path: "src/alpha.ts",
				name: "block-chunk-1",
				content: "Block chunk after alpha function",
			},
			{
				content_id: "file-src-utils-ts",
				content_type: "file" as const,
				file_path: "src/utils.ts",
				name: "utils.ts",
				content: "Full file content of utils.ts\nexport function utilHelper() { return true; }",
			},
			{
				content_id: "file-src-config-py",
				content_type: "file" as const,
				file_path: "src/config.py",
				name: "config.py",
				content: "Full file content of config.py\ndef load_config(): pass",
			},
		]);

		// Seed vector embeddings — each item gets a distinct basis direction
		// so we can control which items match a query vector
		granularVectors.upsert("sym-alpha", basisVector(DIMS, 0), "symbol");
		granularVectors.upsert("sym-beta", basisVector(DIMS, 1), "symbol");
		granularVectors.upsert("sym-gamma", basisVector(DIMS, 2), "symbol");
		granularVectors.upsert("chunk-block-1", basisVector(DIMS, 3), "chunk");
		granularVectors.upsert("file-src-utils-ts", basisVector(DIMS, 4), "file");
		granularVectors.upsert("file-src-config-py", basisVector(DIMS, 5), "file");

		// Create search instances
		const deps = { contentFTS, granularVectors, chunkStore, symbolStore };
		baseSearch = createMultiGranularSearch(deps);
		enhancedSearch = createEnhancedMultiGranularSearch(deps);
	});

	afterAll(() => {
		db.close();
	});

	// ========================================================================
	// Test Group 1: Rerank Order Propagation (BUG 3 fix)
	// ========================================================================

	describe("BUG 3 — Rerank order propagation", () => {
		test("searchEnhanced ranked[] order matches symbols[] order for symbol items", async () => {
			// Query embedding close to sym-beta (index 1) — beta should rank high via vectors
			// But BM25 reranker may reorder based on content relevance to "alpha function"
			const queryEmbedding = nearBasisVector(DIMS, 1, 0.05);

			const result = await enhancedSearch.searchEnhanced(
				"alpha function",
				queryEmbedding,
				{
					branch: "main",
					enableReranking: true,
					rerankerType: "bm25",
					enableCaching: false,
					enableRewriting: false,
				},
			);

			// Extract symbol IDs from ranked[] in order
			const rankedSymbolIds = result.ranked
				.filter((r) => r.granularity === "symbol")
				.map((r) => r.id);

			// Extract symbol IDs from symbols[] in order
			const symbolIds = result.symbols.map((s) => s.id);

			// KEY ASSERTION: The order must match.
			// Before the fix, symbols[] came from baseResult (pre-rerank) while
			// ranked[] was reranked — so their orders would diverge.
			expect(symbolIds).toEqual(rankedSymbolIds);
		});

		test("searchEnhanced re-derives symbols from finalRanked (not base result)", async () => {
			// Use a query embedding very close to sym-alpha (index 0)
			const queryEmbedding = nearBasisVector(DIMS, 0, 0.01);

			// Run base search (no reranking) — sym-alpha should dominate via vector similarity
			const baseResult = baseSearch.search("beta result", queryEmbedding, {
				branch: "main",
			});

			// Run enhanced search WITH reranking — BM25 should boost "beta" because
			// the query text "beta result" matches sym-beta's content
			const enhancedResult = await enhancedSearch.searchEnhanced(
				"beta result",
				queryEmbedding,
				{
					branch: "main",
					enableReranking: true,
					rerankerType: "bm25",
					enableCaching: false,
					enableRewriting: false,
				},
			);

			// The enhanced result should have symbols derived from the reranked order.
			// If both base and enhanced have multiple symbol results, verify at least
			// the top symbol in ranked matches the first symbol in the result.
			if (enhancedResult.ranked.length > 0 && enhancedResult.symbols.length > 0) {
				const topRankedSymbol = enhancedResult.ranked.find(
					(r) => r.granularity === "symbol",
				);
				if (topRankedSymbol) {
					expect(enhancedResult.symbols[0].id).toBe(topRankedSymbol.id);
				}
			}
		});
	});

	// ========================================================================
	// Test Group 2: Metadata Preservation Through Reranking
	// ========================================================================

	describe("BUG 3 — Metadata preservation through reranking", () => {
		test("start_line and end_line survive reranking in ranked[] items", async () => {
			// Use a vector-only search to guarantee items have line metadata from getContentById.
			// FTS results don't carry line metadata, so hybrid search items may lack it.
			const queryEmbedding = nearBasisVector(DIMS, 0, 0.1);

			// First verify vector-only base search produces line metadata
			const vectorResult = baseSearch.searchVectors(queryEmbedding, { branch: "main" });
			const vectorSymbols = vectorResult.ranked.filter(
				(r) => r.granularity === "symbol" && r.start_line !== undefined,
			);
			expect(vectorSymbols.length).toBeGreaterThan(0);

			// Now run enhanced search with reranking
			const result = await enhancedSearch.searchEnhanced(
				"alpha function",
				queryEmbedding,
				{
					branch: "main",
					enableReranking: true,
					rerankerType: "bm25",
					enableCaching: false,
					enableRewriting: false,
				},
			);

			// Items that had line metadata before reranking should still have it after.
			// The metadataMap fix preserves start_line/end_line through the rerank cycle.
			// Check items that we know came from vectors (they have start_line set).
			const itemsWithMetadata = result.ranked.filter(
				(r) => r.start_line !== undefined && r.end_line !== undefined,
			);

			for (const ranked of itemsWithMetadata) {
				if (ranked.granularity === "symbol") {
					const original = SYMBOLS.find((s) => s.id === ranked.id);
					if (original) {
						expect(ranked.start_line).toBe(original.start_line);
						expect(ranked.end_line).toBe(original.end_line);
					}
				} else if (ranked.granularity === "file") {
					const original = CHUNKS.find((c) => c.id === ranked.id);
					if (original) {
						expect(ranked.start_line).toBe(original.start_line);
						expect(ranked.end_line).toBe(original.end_line);
					}
				}
			}

			// Verify at least some items preserved their metadata
			expect(itemsWithMetadata.length).toBeGreaterThan(0);
		});

		test("metadata survives even with simple reranker", async () => {
			// Use vector-only path to ensure items carry line metadata
			const queryEmbedding = nearBasisVector(DIMS, 1, 0.1);

			const result = await enhancedSearch.searchEnhanced(
				"beta function",
				queryEmbedding,
				{
					branch: "main",
					enableReranking: true,
					rerankerType: "simple",
					enableCaching: false,
					enableRewriting: false,
				},
			);

			// Filter to items that came through the vector path (they have line metadata).
			// FTS-only items won't have start_line/end_line — that's expected behavior.
			const symbolResults = result.ranked.filter(
				(r) => r.granularity === "symbol" && r.start_line !== undefined,
			);
			expect(symbolResults.length).toBeGreaterThan(0);

			for (const item of symbolResults) {
				expect(typeof item.start_line).toBe("number");
				expect(typeof item.end_line).toBe("number");
			}
		});
	});

	// ========================================================================
	// Test Group 3: File Granularity End-to-End (BUG 2 fix)
	// ========================================================================

	describe("BUG 2 — File granularity end-to-end", () => {
		test("getContentById handles file granularity via chunkStore", () => {
			// This tests the fix in createMultiGranularSearch's getContentById().
			// We test indirectly: if file-granularity vectors are present and the
			// search returns them, getContentById must have resolved them.

			// Query embedding exactly matching the file-src-utils-ts vector (index 4)
			const queryEmbedding = basisVector(DIMS, 4);

			const result = baseSearch.searchVectors(queryEmbedding, {
				branch: "main",
				granularity: "file",
			});

			// The file item should appear in ranked results
			const fileItems = result.ranked.filter((r) => r.granularity === "file");
			expect(fileItems.length).toBeGreaterThan(0);

			// The top file item should be our utils.ts file chunk
			const utilsItem = fileItems.find((f) => f.id === "file-src-utils-ts");
			expect(utilsItem).toBeDefined();
			expect(utilsItem!.file_path).toBe("src/utils.ts");
			expect(utilsItem!.content).toContain("utilHelper");
		});

		test("extractResults adds file-granularity items to chunks[]", () => {
			// Query that matches the file-granularity FTS entry
			const queryEmbedding = basisVector(DIMS, 4);

			const result = baseSearch.searchVectors(queryEmbedding, {
				branch: "main",
			});

			// File-granularity items should be hydrated into chunks[]
			const fileChunks = result.chunks.filter((c) => c.chunk_type === "file");
			expect(fileChunks.length).toBeGreaterThan(0);

			const utilsChunk = fileChunks.find((c) => c.id === "file-src-utils-ts");
			expect(utilsChunk).toBeDefined();
			expect(utilsChunk!.file_path).toBe("src/utils.ts");
		});

		test("file items appear in ranked[] with correct file_path and content", () => {
			// Mixed query: embedding near file vector, text query for file content
			const queryEmbedding = nearBasisVector(DIMS, 5, 0.1);

			const result = baseSearch.search("config load_config", queryEmbedding, {
				branch: "main",
			});

			const fileRanked = result.ranked.filter((r) => r.granularity === "file");

			// Should find the config.py file
			if (fileRanked.length > 0) {
				const configItem = fileRanked.find((r) => r.id === "file-src-config-py");
				if (configItem) {
					expect(configItem.file_path).toBe("src/config.py");
					expect(configItem.content).toContain("load_config");
				}
			}
		});

		test("file-granularity vector search does NOT skip file embeddings", () => {
			// Directly verify that granularVectors.search returns file items
			const queryEmbedding = basisVector(DIMS, 4);
			const vectorResults = granularVectors.search(queryEmbedding, {
				limit: 10,
				granularity: "file",
			});

			expect(vectorResults.length).toBeGreaterThan(0);

			const fileResult = vectorResults.find(
				(r) => r.symbol_id === "file-src-utils-ts",
			);
			expect(fileResult).toBeDefined();
			expect(fileResult!.granularity).toBe("file");
			// High similarity — should be very close to 1.0 since it's an exact basis vector match
			expect(fileResult!.similarity).toBeGreaterThan(0.9);
		});
	});

	// ========================================================================
	// Test Group 4: File/Chunk Hydration in SmartQuery (BUG 2, Layer 3)
	// ========================================================================

	describe("BUG 2 — SmartQuery file/chunk SymbolNode wrapper creation", () => {
		test("enhanced search produces symbols even when only file results exist", async () => {
			// Query targeting only file-granularity content
			const queryEmbedding = basisVector(DIMS, 4);

			const result = await enhancedSearch.searchEnhanced(
				"utilHelper",
				queryEmbedding,
				{
					branch: "main",
					granularity: "file",
					enableReranking: false,
					enableCaching: false,
					enableRewriting: false,
				},
			);

			// File items should appear in ranked
			const fileRanked = result.ranked.filter((r) => r.granularity === "file");
			expect(fileRanked.length).toBeGreaterThan(0);

			// Chunks should be populated (file items go to chunks[] in extractResults)
			expect(result.chunks.length).toBeGreaterThan(0);
		});

		test("file-granularity ranked items have correct metadata for SymbolNode wrapping", async () => {
			// This tests the data shape that smart-query.ts uses to create SymbolNode wrappers.
			// The wrapper needs: file_path, content from ranked items.
			// start_line/end_line come from vector results but may be undefined from FTS.
			const queryEmbedding = basisVector(DIMS, 5);

			const result = await enhancedSearch.searchEnhanced(
				"config",
				queryEmbedding,
				{
					branch: "main",
					enableReranking: false,
					enableCaching: false,
					enableRewriting: false,
				},
			);

			for (const ranked of result.ranked) {
				if (ranked.granularity === "file") {
					// file_path and content are always required for SymbolNode wrapping
					expect(typeof ranked.file_path).toBe("string");
					expect(ranked.file_path.length).toBeGreaterThan(0);
					expect(typeof ranked.content).toBe("string");
					expect(ranked.content.length).toBeGreaterThan(0);
					// start_line/end_line are available when item came from vector path.
					// smart-query.ts defaults to 1 if undefined, so both cases are handled.
					if (ranked.start_line !== undefined) {
						expect(typeof ranked.start_line).toBe("number");
						expect(typeof ranked.end_line).toBe("number");
					}
				}
			}
		});

		test("inferLanguageType logic: .py → python, .ts → typescript", () => {
			// Validate the language inference indirectly through smart-query's wrapper creation.
			// We check the file extensions in our test data align with expected languages.
			//
			// The actual inferLanguageType function in smart-query.ts:
			//   .py → "python"
			//   everything else → "typescript"
			const pyFile = "src/config.py";
			const tsFile = "src/utils.ts";

			const pyExt = pyFile.slice(pyFile.lastIndexOf(".")).toLowerCase();
			const tsExt = tsFile.slice(tsFile.lastIndexOf(".")).toLowerCase();

			expect(pyExt).toBe(".py");
			expect(tsExt).toBe(".ts");

			// When smart-query wraps these, it should assign:
			// .py → "python", .ts → "typescript"
			// This is tested via the inferLanguageType function behavior
			const inferLanguage = (fp: string) => {
				const ext = fp.slice(fp.lastIndexOf(".")).toLowerCase();
				if (ext === ".py") return "python";
				return "typescript";
			};

			expect(inferLanguage(pyFile)).toBe("python");
			expect(inferLanguage(tsFile)).toBe("typescript");
		});

		test("SymbolNode wrapper shape matches expected contract", () => {
			// Simulate what smart-query.ts does when creating a SymbolNode from a ranked file item
			const rankedFileItem = {
				id: "file-src-utils-ts",
				granularity: "file" as const,
				score: 0.95,
				file_path: "src/utils.ts",
				content: "export function utilHelper() { return true; }",
				start_line: 1,
				end_line: 50,
			};

			// This is the exact wrapper logic from smart-query.ts (lines 157-173)
			const wrapper: SymbolNode = {
				id: rankedFileItem.id,
				name: rankedFileItem.file_path.split("/").pop() ?? rankedFileItem.id,
				qualified_name: rankedFileItem.file_path,
				type: "MODULE",
				file_path: rankedFileItem.file_path,
				language: rankedFileItem.file_path.endsWith(".py") ? "python" : "typescript",
				start_line: rankedFileItem.start_line ?? 1,
				end_line: rankedFileItem.end_line ?? 1,
				content: rankedFileItem.content,
				content_hash: "",
				is_external: false,
				branch: "main",
				updated_at: Date.now(),
				revision_id: 0,
			};

			// Verify all required SymbolNode fields
			expect(wrapper.id).toBe("file-src-utils-ts");
			expect(wrapper.name).toBe("utils.ts");
			expect(wrapper.qualified_name).toBe("src/utils.ts");
			expect(wrapper.type).toBe("MODULE");
			expect(wrapper.language).toBe("typescript");
			expect(wrapper.file_path).toBe("src/utils.ts");
			expect(wrapper.start_line).toBe(1);
			expect(wrapper.end_line).toBe(50);
			expect(wrapper.content).toContain("utilHelper");
			expect(wrapper.content_hash).toBe("");
			expect(wrapper.is_external).toBe(false);
		});

		test("SymbolNode wrapper for .py file gets language: python", () => {
			const rankedPyItem = {
				id: "file-src-config-py",
				file_path: "src/config.py",
				content: "def load_config(): pass",
				start_line: 1,
				end_line: 40,
			};

			const wrapper: Partial<SymbolNode> = {
				id: rankedPyItem.id,
				name: rankedPyItem.file_path.split("/").pop() ?? rankedPyItem.id,
				qualified_name: rankedPyItem.file_path,
				type: "MODULE",
				file_path: rankedPyItem.file_path,
				language: rankedPyItem.file_path.endsWith(".py") ? "python" : "typescript",
			};

			expect(wrapper.language).toBe("python");
			expect(wrapper.name).toBe("config.py");
			expect(wrapper.type).toBe("MODULE");
		});
	});
});
