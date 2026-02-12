#!/usr/bin/env bun
/**
 * FULL PIPELINE TEST v2 for @op1/code-intel
 * 
 * Tests the complete end-to-end flow with fallback support:
 * 1. Extract symbols from files
 * 2. Generate embeddings (auto-select best available)
 * 3. Store in pure JS vector store (no native deps)
 * 4. Vector similarity search
 * 5. Hybrid search (vector + keyword)
 * 6. Smart query with context
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

// Imports
import {
	createSymbolStore,
	createEdgeStore,
	createKeywordStore,
	createPureVectorStore,
} from "../storage";

import {
	generateCanonicalId,
	generateContentHash,
	createTypeScriptAdapter,
} from "../extraction";

import { createAutoEmbedder } from "../embeddings";

import type { SymbolNode } from "../types";

console.log("=".repeat(70));
console.log("@op1/code-intel - FULL PIPELINE TEST v2 (No Native Deps)");
console.log("=".repeat(70));

const WORKSPACE_ROOT = process.cwd();
let allTestsPassed = true;
const testResults: Record<string, { passed: boolean; details: string }> = {};

function logTest(name: string, passed: boolean, details: string) {
	testResults[name] = { passed, details };
	const icon = passed ? "✅" : "❌";
	console.log(`\n${icon} TEST: ${name}`);
	console.log(`   ${details}`);
	if (!passed) allTestsPassed = false;
}

// ============================================================================
// STEP 1: Database Setup
// ============================================================================

console.log("\n📦 STEP 1: Setting up database...");

const db = new Database(":memory:");

// Create regular tables
db.run(`
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
		branch TEXT NOT NULL DEFAULT 'main',
		embedding_model_id TEXT,
		updated_at INTEGER NOT NULL,
		revision_id INTEGER NOT NULL DEFAULT 0
	)
`);

db.run(`
	CREATE TABLE IF NOT EXISTS edges (
		id TEXT PRIMARY KEY,
		source_id TEXT NOT NULL,
		target_id TEXT NOT NULL,
		type TEXT NOT NULL,
		confidence REAL NOT NULL,
		origin TEXT NOT NULL,
		branch TEXT NOT NULL DEFAULT 'main',
		source_start_line INTEGER,
		source_end_line INTEGER,
		target_start_line INTEGER,
		target_end_line INTEGER,
		updated_at INTEGER NOT NULL,
		metadata TEXT
	)
`);

// Create js_vectors with granularity column expected by vector-search fallback
// (createPureVectorStore will reuse this table)
db.run(`
	CREATE TABLE IF NOT EXISTS js_vectors (
		symbol_id TEXT PRIMARY KEY,
		embedding TEXT NOT NULL,
		granularity TEXT NOT NULL DEFAULT 'symbol',
		updated_at INTEGER NOT NULL
	)
`);

// Create chunks table used by pure JS vector search join path
// (smart-query's vector-search fallback LEFT JOINs this table)
db.run(`
	CREATE TABLE IF NOT EXISTS chunks (
		id TEXT PRIMARY KEY,
		file_path TEXT NOT NULL,
		branch TEXT NOT NULL DEFAULT 'main',
		parent_symbol_id TEXT,
		content TEXT
	)
`);

// Create FTS5 table for keyword search
db.run(`
	CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
		symbol_id,
		name,
		qualified_name,
		content,
		file_path,
		tokenize='trigram'
	)
`);

logTest("Database Setup", true, "Created symbols, edges, js_vectors, chunks, FTS5 tables");

// ============================================================================
// STEP 2: Create stores
// ============================================================================

console.log("\n📦 STEP 2: Initializing stores...");

const symbolStore = createSymbolStore(db);
const edgeStore = createEdgeStore(db);
const keywordStore = createKeywordStore(db);
const vectorStore = createPureVectorStore(db);

logTest("Store Initialization", true, "Created symbol, edge, keyword, and vector stores");

// ============================================================================
// STEP 3: Extract symbols from real files
// ============================================================================

console.log("\n📝 STEP 3: Extracting symbols from real TypeScript files...");

const adapter = createTypeScriptAdapter();
const branch = "main";

const sourceFiles = [
	"src/types.ts",
	"src/diagnostics/logger.ts",
	"src/diagnostics/metrics.ts",
];

const allSymbols: SymbolNode[] = [];

for (const filePath of sourceFiles) {
	const fullPath = join(WORKSPACE_ROOT, filePath);
	
	try {
		const file = Bun.file(fullPath);
		if (!(await file.exists())) {
			console.log(`  ⚠️  File not found: ${filePath}`);
			continue;
		}
		
		const content = await file.text();
		const rawSymbols = await adapter.extractSymbols(content, filePath);
		
		console.log(`  📄 ${filePath}: ${rawSymbols.length} symbols`);
		
		for (const raw of rawSymbols) {
			const symbol: SymbolNode = {
				id: generateCanonicalId(raw.qualified_name, raw.signature, "typescript"),
				name: raw.name,
				qualified_name: raw.qualified_name,
				type: raw.type,
				language: "typescript",
				file_path: filePath,
				start_line: raw.start_line,
				end_line: raw.end_line,
				content: raw.content,
				signature: raw.signature,
				docstring: raw.docstring,
				content_hash: generateContentHash(raw.content),
				is_external: false,
				branch,
				updated_at: Date.now(),
				revision_id: 1,
			};
			
			allSymbols.push(symbol);
			symbolStore.upsert(symbol);
			
			// Index in FTS5 for keyword search
			keywordStore.index(
				symbol.id,
				symbol.name,
				symbol.qualified_name,
				symbol.content,
				symbol.file_path
			);
		}
	} catch (error) {
		console.log(`  ❌ Error: ${error}`);
	}
}

logTest("Symbol Extraction", allSymbols.length > 0, `Extracted ${allSymbols.length} symbols from ${sourceFiles.length} files`);

// ============================================================================
// STEP 4: Generate embeddings (auto-select best available)
// ============================================================================

console.log("\n🧠 STEP 4: Generating embeddings...");

const embedder = await createAutoEmbedder();
console.log(`  Using embedder: ${embedder.modelId}`);

// Generate embeddings for all symbols
const symbolsToEmbed = allSymbols.slice(0, 20); // Limit for speed
const embeddings: number[][] = [];

const startEmbedTime = Date.now();
for (const symbol of symbolsToEmbed) {
	const embedding = await embedder.embed(symbol.content);
	embeddings.push(embedding);
}
const embedTime = Date.now() - startEmbedTime;

logTest(
	"Embedding Generation",
	embeddings.length > 0 && embeddings[0].length > 0,
	`Generated ${embeddings.length} embeddings (${embeddings[0]?.length || 0}-dim) in ${embedTime}ms. Model: ${embedder.modelId}`
);

// ============================================================================
// STEP 5: Store embeddings in vector store
// ============================================================================

console.log("\n💾 STEP 5: Storing embeddings in vector store...");

for (let i = 0; i < symbolsToEmbed.length; i++) {
	vectorStore.upsert(symbolsToEmbed[i].id, embeddings[i]);
}

const vectorCount = vectorStore.count();
logTest("Vector Storage", vectorCount === symbolsToEmbed.length, `Stored ${vectorCount} vectors in pure JS vector store`);

// ============================================================================
// STEP 6: Vector similarity search
// ============================================================================

console.log("\n🔍 STEP 6: Testing vector similarity search...");

// Create a query embedding
const queryCode = "function createLogger(options) { return new Logger(options); }";
const queryEmbedding = await embedder.embed(queryCode);

const vectorResults = vectorStore.search(queryEmbedding, 5);

logTest(
	"Vector Search",
	vectorResults.length > 0,
	`Found ${vectorResults.length} similar vectors. Top similarity: ${vectorResults[0]?.similarity.toFixed(4) || "N/A"}`
);

// Show top results
if (vectorResults.length > 0) {
	console.log("  Top 3 results:");
	for (let i = 0; i < Math.min(3, vectorResults.length); i++) {
		const result = vectorResults[i];
		const symbol = symbolStore.getById(result.symbol_id);
		console.log(`    ${i + 1}. ${symbol?.name || "?"} (similarity: ${result.similarity.toFixed(4)})`);
	}
}

// ============================================================================
// STEP 7: Keyword search (FTS5)
// ============================================================================

console.log("\n🔤 STEP 7: Testing keyword search (FTS5)...");

const keywordResults = keywordStore.search("Logger", 10);
logTest(
	"Keyword Search",
	keywordResults.length > 0,
	`Found ${keywordResults.length} results for "Logger". Top: ${keywordResults[0]?.name || "none"}`
);

// ============================================================================
// STEP 8: RRF Fusion (Hybrid Search)
// ============================================================================

console.log("\n🔀 STEP 8: Testing RRF fusion (hybrid search)...");

const { fuseWithRrf } = await import("../query/rrf-fusion");

// Convert to ranked items format
const vectorRanked = vectorResults.map(r => ({ symbolId: r.symbol_id }));
const keywordRanked = keywordResults.map(r => ({ symbolId: r.symbol_id }));

const fusedResults = fuseWithRrf(vectorRanked, keywordRanked);

logTest(
	"Hybrid Search (RRF)",
	fusedResults.length > 0,
	`Fused ${vectorRanked.length} vector + ${keywordRanked.length} keyword results into ${fusedResults.length} ranked results`
);

// ============================================================================
// STEP 9: Smart Query (Full Pipeline)
// ============================================================================

console.log("\n🎯 STEP 9: Testing Smart Query (full pipeline)...");

const { createSmartQuery } = await import("../query/smart-query");

const smartQuery = createSmartQuery(db, symbolStore, edgeStore);

// Query with both embedding and text
const result = await smartQuery.search({
	embedding: queryEmbedding,
	queryText: "Logger",
	maxTokens: 4000,
	branch: "main",
});

logTest(
	"Smart Query (hybrid)",
	result.metadata.vectorHits > 0 || result.metadata.keywordHits > 0,
	`Query completed in ${result.metadata.queryTime}ms. Vector: ${result.metadata.vectorHits}, Keyword: ${result.metadata.keywordHits}, Confidence: ${result.metadata.confidence}`
);

// ============================================================================
// STEP 10: Context Building
// ============================================================================

console.log("\n📝 STEP 10: Testing context building...");

logTest(
	"Context Building",
	result.context.length > 0,
	`Generated ${result.tokenCount} tokens of context. Symbols included: ${result.symbols.length}`
);

// Show a snippet of context
if (result.context.length > 0) {
	console.log("  Context snippet (first 300 chars):");
	console.log("  " + result.context.slice(0, 300).replace(/\n/g, "\n  ") + "...");
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log("FULL PIPELINE TEST SUMMARY");
console.log("=".repeat(70));

console.log("\n📋 Test Results:\n");

for (const [name, result] of Object.entries(testResults)) {
	const icon = result.passed ? "✅" : "❌";
	console.log(`${icon} ${name}`);
	console.log(`   ${result.details}\n`);
}

const passedCount = Object.values(testResults).filter(r => r.passed).length;
const totalCount = Object.keys(testResults).length;

console.log("=".repeat(70));
console.log(`RESULT: ${passedCount}/${totalCount} tests passed`);

if (allTestsPassed) {
	console.log("🎉 ALL TESTS PASSED - Full pipeline working!");
	console.log("\n✨ PIPELINE VERIFIED:");
	console.log("   1. Symbol Extraction ✅");
	console.log("   2. Embedding Generation ✅");
	console.log("   3. Vector Storage ✅");
	console.log("   4. Vector Search ✅");
	console.log("   5. Keyword Search ✅");
	console.log("   6. Hybrid Search (RRF) ✅");
	console.log("   7. Smart Query ✅");
	console.log("   8. Context Building ✅");
} else {
	console.log("❌ SOME TESTS FAILED - See details above");
	process.exit(1);
}
console.log("=".repeat(70));

// Cleanup
db.close();
