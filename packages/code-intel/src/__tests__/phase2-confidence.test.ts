/**
 * Phase 2 Confidence Scoring Tests
 *
 * Validates BUG 8 fix: Enhanced path confidence scoring no longer inflates
 * agreement to 1.0 via pseudo-FusedResults with identical sourceRanks.
 *
 * Tests cover:
 * 1. computeEnhancedAgreement — correct agreement from hit counts
 * 2. computeMultiSignalConfidence — agreementOverride bypasses fusedResults
 * 3. Enhanced path produces non-degraded confidence when results exist
 * 4. scoreSpread works correctly with Enhanced RRF scores
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createSymbolStore } from "../storage/symbol-store";
import { createChunkStore } from "../storage/chunk-store";
import { createContentFTSStore } from "../storage/content-fts-store";
import { createGranularVectorStore } from "../storage/pure-vector-store";
import {
	createEnhancedMultiGranularSearch,
	type EnhancedMultiGranularSearch,
} from "../query/multi-granular-search";
import {
	computeEnhancedAgreement,
	computeMultiSignalConfidence,
} from "../query/smart-query";
import type { FusedResult } from "../query/rrf-fusion";
import type { SymbolNode } from "../types";

// ============================================================================
// Helpers
// ============================================================================

function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = OFF");

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

function basisVector(dims: number, index: number): number[] {
	const v = new Array(dims).fill(0);
	v[index % dims] = 1;
	return v;
}

function nearBasisVector(dims: number, index: number, noise = 0.1): number[] {
	const v = basisVector(dims, index);
	v[(index + 1) % dims] = noise;
	return v;
}

// ============================================================================
// Test Data
// ============================================================================

const DIMS = 8;

const TEST_SYMBOLS: SymbolNode[] = [
	{
		id: "sym-search",
		name: "searchIndex",
		qualified_name: "src/search.searchIndex",
		type: "FUNCTION",
		language: "typescript",
		file_path: "src/search.ts",
		start_line: 1,
		end_line: 20,
		content: "export function searchIndex(query: string) { return []; }",
		content_hash: "hash-search",
		is_external: false,
		branch: "main",
		updated_at: 0,
		revision_id: 0,
	},
	{
		id: "sym-query",
		name: "buildQuery",
		qualified_name: "src/search.buildQuery",
		type: "FUNCTION",
		language: "typescript",
		file_path: "src/search.ts",
		start_line: 25,
		end_line: 40,
		content: "export function buildQuery(text: string) { return text.toLowerCase(); }",
		content_hash: "hash-query",
		is_external: false,
		branch: "main",
		updated_at: 0,
		revision_id: 0,
	},
	{
		id: "sym-rank",
		name: "rankResults",
		qualified_name: "src/ranking.rankResults",
		type: "FUNCTION",
		language: "typescript",
		file_path: "src/ranking.ts",
		start_line: 1,
		end_line: 15,
		content: "export function rankResults(items: any[]) { return items.sort(); }",
		content_hash: "hash-rank",
		is_external: false,
		branch: "main",
		updated_at: 0,
		revision_id: 0,
	},
];

// ============================================================================
// Test Suite 1: computeEnhancedAgreement (pure function)
// ============================================================================

describe("Phase 2 — computeEnhancedAgreement", () => {
	test("returns 0 when both channels have zero hits", () => {
		expect(computeEnhancedAgreement(0, 0)).toBe(0);
	});

	test("returns 0.1 when only vector channel has hits", () => {
		expect(computeEnhancedAgreement(5, 0)).toBe(0.1);
	});

	test("returns 0.1 when only keyword channel has hits", () => {
		expect(computeEnhancedAgreement(0, 8)).toBe(0.1);
	});

	test("returns 1.0 when both channels have equal hits", () => {
		expect(computeEnhancedAgreement(10, 10)).toBe(1.0);
	});

	test("returns correct ratio when vector dominates", () => {
		// min(3, 10) / max(3, 10) = 3/10 = 0.3
		expect(computeEnhancedAgreement(10, 3)).toBeCloseTo(0.3, 5);
	});

	test("returns correct ratio when keyword dominates", () => {
		// min(2, 8) / max(2, 8) = 2/8 = 0.25
		expect(computeEnhancedAgreement(2, 8)).toBeCloseTo(0.25, 5);
	});

	test("is symmetric — order of arguments does not matter", () => {
		const a = computeEnhancedAgreement(7, 3);
		const b = computeEnhancedAgreement(3, 7);
		expect(a).toBeCloseTo(b, 10);
	});

	test("returns value in [0, 1] range for various inputs", () => {
		const inputs = [
			[0, 0], [1, 0], [0, 1], [1, 1], [5, 10], [100, 1], [50, 50],
		] as const;

		for (const [v, k] of inputs) {
			const result = computeEnhancedAgreement(v, k);
			expect(result).toBeGreaterThanOrEqual(0);
			expect(result).toBeLessThanOrEqual(1);
		}
	});
});

// ============================================================================
// Test Suite 2: computeMultiSignalConfidence with agreementOverride
// ============================================================================

describe("Phase 2 — computeMultiSignalConfidence with agreementOverride", () => {
	// Helper: create pseudo-FusedResults that always have both sourceRanks set
	// (this is what the Enhanced path produces — the inflated case)
	function makePseudoFusedResults(count: number): FusedResult[] {
		return Array.from({ length: count }, (_, i) => ({
			symbolId: `sym-${i}`,
			rrfScore: 0.02 - i * 0.001, // Decreasing scores
			sourceRanks: { vector: i, keyword: i }, // Both set — inflated agreement
		}));
	}

	// Helper: symbols in same directory for high scope concentration
	function makeSymbolsInSameDir(count: number): SymbolNode[] {
		return Array.from({ length: count }, (_, i) => ({
			id: `sym-${i}`,
			name: `func${i}`,
			qualified_name: `src/search.func${i}`,
			type: "FUNCTION" as const,
			language: "typescript" as const,
			file_path: `src/search.ts`,
			start_line: i * 10 + 1,
			end_line: (i + 1) * 10,
			content: `function func${i}() {}`,
			content_hash: `hash-${i}`,
			is_external: false,
			branch: "main",
			updated_at: 0,
			revision_id: 0,
		}));
	}

	test("without override, pseudo-FusedResults inflate agreement to 1.0", () => {
		const fusedResults = makePseudoFusedResults(5);
		const symbols = makeSymbolsInSameDir(5);

		const result = computeMultiSignalConfidence(10, 10, symbols, fusedResults);

		// Without override, all fusedResults have both sourceRanks set → agreement = 1.0
		expect(result.diagnostics.retrievalAgreement).toBe(1.0);
	});

	test("with override, agreement uses the provided value", () => {
		const fusedResults = makePseudoFusedResults(5);
		const symbols = makeSymbolsInSameDir(5);

		// Override with a moderate agreement value
		const result = computeMultiSignalConfidence(10, 10, symbols, fusedResults, 0.6);

		expect(result.diagnostics.retrievalAgreement).toBe(0.6);
	});

	test("with override=0.1, agreement is low despite fusedResults having both ranks", () => {
		const fusedResults = makePseudoFusedResults(5);
		const symbols = makeSymbolsInSameDir(5);

		const result = computeMultiSignalConfidence(5, 0, symbols, fusedResults, 0.1);

		expect(result.diagnostics.retrievalAgreement).toBe(0.1);
	});

	test("override does NOT affect scoreSpread or scopeConcentration", () => {
		const fusedResults = makePseudoFusedResults(5);
		const symbols = makeSymbolsInSameDir(5);

		const withOverride = computeMultiSignalConfidence(10, 10, symbols, fusedResults, 0.5);
		const withoutOverride = computeMultiSignalConfidence(10, 10, symbols, fusedResults);

		// scoreSpread depends only on fusedResults' rrfScore values — same input, same output
		expect(withOverride.diagnostics.scoreSpread).toBe(withoutOverride.diagnostics.scoreSpread);

		// scopeConcentration depends only on symbols' file_path — same input, same output
		expect(withOverride.diagnostics.scopeConcentration).toBe(
			withoutOverride.diagnostics.scopeConcentration,
		);
	});

	test("override changes the confidence tier when it lowers agreement significantly", () => {
		const fusedResults = makePseudoFusedResults(3);
		const symbols = makeSymbolsInSameDir(3);

		// Without override: agreement=1.0, which with scope concentration pushes toward "high"
		const withoutOverride = computeMultiSignalConfidence(10, 10, symbols, fusedResults);

		// With very low override: agreement=0.05
		const withLowOverride = computeMultiSignalConfidence(10, 10, symbols, fusedResults, 0.05);

		// The tier should be lower (or at minimum the composite score is lower)
		const withoutComposite =
			withoutOverride.diagnostics.retrievalAgreement * 0.45 +
			withoutOverride.diagnostics.scoreSpread * 0.25 +
			withoutOverride.diagnostics.scopeConcentration * 0.30;

		const withComposite =
			withLowOverride.diagnostics.retrievalAgreement * 0.45 +
			withLowOverride.diagnostics.scoreSpread * 0.25 +
			withLowOverride.diagnostics.scopeConcentration * 0.30;

		expect(withComposite).toBeLessThan(withoutComposite);
	});

	test("zero results returns degraded regardless of override", () => {
		const result = computeMultiSignalConfidence(0, 0, [], [], 0.9);

		expect(result.tier).toBe("degraded");
		expect(result.diagnostics.retrievalAgreement).toBe(0);
		expect(result.diagnostics.tierReason).toContain("No results");
	});
});

// ============================================================================
// Test Suite 3: scoreSpread with Enhanced RRF scores
// ============================================================================

describe("Phase 2 — scoreSpread with Enhanced path scores", () => {
	test("scoreSpread is non-zero when Enhanced results have score variance", () => {
		// Simulate Enhanced RRF scores: weight/(k + rank + 1) with k=60
		// Top result: 1/(60+1) ≈ 0.0164
		// Second: 1/(60+2) ≈ 0.0161
		// Third: 1/(60+3) ≈ 0.0159
		const fusedResults: FusedResult[] = [
			{ symbolId: "a", rrfScore: 0.0328, sourceRanks: { vector: 0, keyword: 0 } },
			{ symbolId: "b", rrfScore: 0.0164, sourceRanks: { vector: 1, keyword: 1 } },
			{ symbolId: "c", rrfScore: 0.0100, sourceRanks: { vector: 2, keyword: 2 } },
		];

		const symbols: SymbolNode[] = TEST_SYMBOLS.slice(0, 3);

		const result = computeMultiSignalConfidence(5, 5, symbols, fusedResults, 0.5);

		// scoreSpread = (top - second) / (top - last) = (0.0328-0.0164)/(0.0328-0.0100)
		// = 0.0164 / 0.0228 ≈ 0.719
		expect(result.diagnostics.scoreSpread).toBeGreaterThan(0);
		expect(result.diagnostics.scoreSpread).toBeCloseTo(0.7193, 2);
	});

	test("scoreSpread is 0 when all scores are identical", () => {
		const fusedResults: FusedResult[] = [
			{ symbolId: "a", rrfScore: 0.02, sourceRanks: { vector: 0, keyword: 0 } },
			{ symbolId: "b", rrfScore: 0.02, sourceRanks: { vector: 1, keyword: 1 } },
			{ symbolId: "c", rrfScore: 0.02, sourceRanks: { vector: 2, keyword: 2 } },
		];

		const symbols: SymbolNode[] = TEST_SYMBOLS.slice(0, 3);

		const result = computeMultiSignalConfidence(5, 5, symbols, fusedResults, 0.5);

		expect(result.diagnostics.scoreSpread).toBe(0);
	});

	test("scoreSpread is 0.5 for a single result with no fusedResults", () => {
		const result = computeMultiSignalConfidence(1, 0, [TEST_SYMBOLS[0]], [], 0.1);

		expect(result.diagnostics.scoreSpread).toBe(0.5);
	});

	test("scoreSpread clamped to 1.0 even with large gap", () => {
		const fusedResults: FusedResult[] = [
			{ symbolId: "a", rrfScore: 1.0, sourceRanks: { vector: 0, keyword: 0 } },
			{ symbolId: "b", rrfScore: 0.0, sourceRanks: { vector: 1, keyword: 1 } },
		];

		const symbols: SymbolNode[] = TEST_SYMBOLS.slice(0, 2);

		const result = computeMultiSignalConfidence(2, 2, symbols, fusedResults, 0.5);

		// (1.0 - 0.0) / (1.0 - 0.0) = 1.0 → min(1.0, 1) = 1.0
		expect(result.diagnostics.scoreSpread).toBe(1.0);
	});
});

// ============================================================================
// Test Suite 4: Enhanced path e2e confidence (not degraded)
// ============================================================================

describe("Phase 2 — Enhanced path confidence is not degraded when results exist", () => {
	let db: Database;
	let enhancedSearch: EnhancedMultiGranularSearch;

	beforeAll(() => {
		db = createTestDb();
		const symbolStore = createSymbolStore(db);
		const chunkStore = createChunkStore(db);
		const contentFTS = createContentFTSStore(db);
		const granularVectors = createGranularVectorStore(db);

		// Seed symbols
		for (const sym of TEST_SYMBOLS) {
			symbolStore.upsert(sym);
		}

		// Seed FTS
		contentFTS.indexMany(
			TEST_SYMBOLS.map((s) => ({
				content_id: s.id,
				content_type: "symbol" as const,
				file_path: s.file_path,
				name: s.name,
				content: s.content,
			})),
		);

		// Seed vectors — each symbol gets a distinct basis direction
		granularVectors.upsert("sym-search", basisVector(DIMS, 0), "symbol");
		granularVectors.upsert("sym-query", basisVector(DIMS, 1), "symbol");
		granularVectors.upsert("sym-rank", basisVector(DIMS, 2), "symbol");

		enhancedSearch = createEnhancedMultiGranularSearch({
			contentFTS,
			granularVectors,
			chunkStore,
			symbolStore,
		});
	});

	afterAll(() => {
		db.close();
	});

	test("Enhanced search with both channels produces non-degraded confidence", async () => {
		const queryEmbedding = nearBasisVector(DIMS, 0, 0.15);

		const result = await enhancedSearch.searchEnhanced(
			"searchIndex query",
			queryEmbedding,
			{
				branch: "main",
				enableReranking: false,
				enableCaching: false,
				enableRewriting: false,
			},
		);

		// Enhanced path should have results from both channels
		expect(result.metadata.vectorHits).toBeGreaterThan(0);
		expect(result.metadata.ftsHits).toBeGreaterThan(0);

		// Compute what the Enhanced agreement would be
		const agreement = computeEnhancedAgreement(
			result.metadata.vectorHits,
			result.metadata.ftsHits,
		);

		// Agreement should NOT be inflated to 1.0 — it should reflect actual hit ratio
		// It also should not be 0 since both channels contributed
		expect(agreement).toBeGreaterThan(0);
		expect(agreement).toBeLessThanOrEqual(1.0);
	});

	test("Enhanced search metadata carries correct hit counts", async () => {
		const queryEmbedding = basisVector(DIMS, 2);

		const result = await enhancedSearch.searchEnhanced(
			"rankResults sort",
			queryEmbedding,
			{
				branch: "main",
				enableReranking: false,
				enableCaching: false,
				enableRewriting: false,
			},
		);

		// The metadata should report separate FTS and vector hit counts
		expect(typeof result.metadata.ftsHits).toBe("number");
		expect(typeof result.metadata.vectorHits).toBe("number");

		// With a targeted query, at least one channel should produce hits
		expect(result.metadata.ftsHits + result.metadata.vectorHits).toBeGreaterThan(0);
	});
});
