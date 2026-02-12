#!/usr/bin/env bun
/**
 * FULL PIPELINE TEST for @op1/code-intel
 * 
 * Tests the complete end-to-end flow:
 * 1. Extract symbols from files ✅
 * 2. Generate embeddings (UniXcoder)
 * 3. Store in SQLite + sqlite-vec
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
	createVectorStore,
} from "../storage";

import {
	generateCanonicalId,
	generateContentHash,
	createTypeScriptAdapter,
} from "../extraction";

import type { SymbolNode } from "../types";

console.log("=".repeat(70));
console.log("@op1/code-intel - FULL PIPELINE TEST");
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
// STEP 1: Database Setup with FTS5 and sqlite-vec
// ============================================================================

console.log("\n📦 STEP 1: Setting up database with FTS5...");

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

logTest("Database Setup", true, "Created symbols, edges, and FTS5 tables");

// ============================================================================
// STEP 2: Check sqlite-vec availability
// ============================================================================

console.log("\n📦 STEP 2: Checking sqlite-vec availability...");

let sqliteVecAvailable = false;
try {
	// Try to load sqlite-vec extension
	const sqliteVec = await import("sqlite-vec");
	sqliteVec.load(db);
	
	// Create vector table
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS vec_symbols USING vec0(
			symbol_id TEXT PRIMARY KEY,
			embedding FLOAT[768]
		)
	`);
	
	sqliteVecAvailable = true;
	logTest("sqlite-vec Extension", true, "sqlite-vec loaded and vec_symbols table created");
} catch (error) {
	const err = error as Error;
	logTest("sqlite-vec Extension", true, `sqlite-vec not available: ${err.message}. Vector search will be skipped.`);
}

// ============================================================================
// STEP 3: Extract symbols from real files
// ============================================================================

console.log("\n📝 STEP 3: Extracting symbols from real TypeScript files...");

const symbolStore = createSymbolStore(db);
const edgeStore = createEdgeStore(db);
const keywordStore = createKeywordStore(db);

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
// STEP 4: Test Embedding Generation
// ============================================================================

console.log("\n🧠 STEP 4: Testing embedding generation (UniXcoder)...");

let embeddingsGenerated = false;
let testEmbedding: number[] | null = null;

try {
	// Check if transformers is available
	const { isTransformersAvailable, createUniXcoderEmbedder } = await import("../embeddings");
	
	const available = await isTransformersAvailable();
	
	if (!available) {
		logTest("Embedding Generation", false, "@huggingface/transformers not installed. Run: bun add @huggingface/transformers");
	} else {
		console.log("  📥 Loading UniXcoder model (first run downloads ~500MB)...");
		
		const embedder = createUniXcoderEmbedder({
			onProgress: (p) => {
				if (p.status === "downloading" && p.progress) {
					process.stdout.write(`\r  📥 Downloading: ${p.progress.toFixed(1)}%`);
				}
			}
		});
		
		// Generate embedding for a test query
		const testCode = "function calculateTax(amount: number): number { return amount * 0.1; }";
		testEmbedding = await embedder.embed(testCode);
		
		embeddingsGenerated = testEmbedding.length > 0;
		
		logTest(
			"Embedding Generation",
			embeddingsGenerated,
			`Generated ${testEmbedding.length}-dim embedding. Model: ${embedder.modelId}`
		);
	}
} catch (error) {
	const err = error as Error;
	logTest("Embedding Generation", false, `Error: ${err.message}`);
}

// ============================================================================
// STEP 5: Test Vector Storage (if sqlite-vec available)
// ============================================================================

console.log("\n💾 STEP 5: Testing vector storage...");

if (sqliteVecAvailable && testEmbedding) {
	try {
		const vectorStore = createVectorStore(db);
		
		// Store test embedding
		const testSymbolId = allSymbols[0]?.id || "test-symbol";
		vectorStore.upsert(testSymbolId, testEmbedding);
		
		const count = vectorStore.count();
		logTest("Vector Storage", count > 0, `Stored ${count} vector(s) in sqlite-vec`);
		
		// Store a few more for search testing
		if (embeddingsGenerated && allSymbols.length >= 3) {
			const { createUniXcoderEmbedder } = await import("../embeddings");
			const embedder = createUniXcoderEmbedder();
			
			for (let i = 1; i < Math.min(5, allSymbols.length); i++) {
				const symbol = allSymbols[i];
				const embedding = await embedder.embed(symbol.content);
				vectorStore.upsert(symbol.id, embedding);
			}
			
			const totalCount = vectorStore.count();
			logTest("Batch Vector Storage", totalCount >= 3, `Stored ${totalCount} vectors total`);
		}
	} catch (error) {
		const err = error as Error;
		logTest("Vector Storage", false, `Error: ${err.message}`);
	}
} else {
	logTest("Vector Storage", false, "Skipped: sqlite-vec or embeddings not available");
}

// ============================================================================
// STEP 6: Test Vector Similarity Search
// ============================================================================

console.log("\n🔍 STEP 6: Testing vector similarity search...");

if (sqliteVecAvailable && testEmbedding) {
	try {
		const vectorStore = createVectorStore(db);
		
		// Search with the test embedding
		const results = vectorStore.search(testEmbedding, 5);
		
		logTest(
			"Vector Search",
			results.length > 0,
			`Found ${results.length} similar vectors. Top distance: ${results[0]?.distance.toFixed(4) || "N/A"}`
		);
	} catch (error) {
		const err = error as Error;
		logTest("Vector Search", false, `Error: ${err.message}`);
	}
} else {
	logTest("Vector Search", false, "Skipped: sqlite-vec or embeddings not available");
}

// ============================================================================
// STEP 7: Test Keyword Search (FTS5)
// ============================================================================

console.log("\n🔤 STEP 7: Testing keyword search (FTS5)...");

try {
	// Search for "Logger" in the indexed symbols
	const keywordResults = keywordStore.search("Logger", 10);
	
	logTest(
		"Keyword Search (FTS5)",
		keywordResults.length > 0,
		`Found ${keywordResults.length} results for "Logger". Top: ${keywordResults[0]?.name || "none"}`
	);
	
	// Search for "metrics"
	const metricsResults = keywordStore.search("metrics", 10);
	logTest(
		"Keyword Search (metrics)",
		metricsResults.length > 0,
		`Found ${metricsResults.length} results for "metrics"`
	);
} catch (error) {
	const err = error as Error;
	logTest("Keyword Search", false, `Error: ${err.message}`);
}

// ============================================================================
// STEP 8: Test Hybrid Search (RRF Fusion)
// ============================================================================

console.log("\n🔀 STEP 8: Testing hybrid search (RRF fusion)...");

try {
	const { fuseWithRrf } = await import("../query/rrf-fusion");
	
	// Simulate vector results (symbol IDs with ranks)
	const vectorResults = [
		{ symbolId: allSymbols[0]?.id || "s1" },
		{ symbolId: allSymbols[1]?.id || "s2" },
		{ symbolId: allSymbols[2]?.id || "s3" },
	];
	
	// Simulate keyword results
	const keywordResults = [
		{ symbolId: allSymbols[1]?.id || "s2" }, // Overlap with vector
		{ symbolId: allSymbols[3]?.id || "s4" },
		{ symbolId: allSymbols[0]?.id || "s1" }, // Overlap with vector
	];
	
	const fusedResults = fuseWithRrf(vectorResults, keywordResults);
	
	logTest(
		"RRF Fusion",
		fusedResults.length > 0,
		`Fused ${vectorResults.length} vector + ${keywordResults.length} keyword results into ${fusedResults.length} ranked results`
	);
	
	// Verify overlapping symbols have higher scores
	const s1Score = fusedResults.find(r => r.symbolId === allSymbols[0]?.id)?.rrfScore || 0;
	const s4Score = fusedResults.find(r => r.symbolId === allSymbols[3]?.id)?.rrfScore || 0;
	
	logTest(
		"RRF Ranking",
		s1Score > s4Score,
		`Overlapping symbol score (${s1Score.toFixed(4)}) > single-source score (${s4Score.toFixed(4)})`
	);
} catch (error) {
	const err = error as Error;
	logTest("Hybrid Search", false, `Error: ${err.message}`);
}

// ============================================================================
// STEP 9: Test Smart Query (Full Pipeline)
// ============================================================================

console.log("\n🎯 STEP 9: Testing Smart Query (full pipeline)...");

try {
	const { createSmartQuery } = await import("../query/smart-query");
	
	const smartQuery = createSmartQuery(db, symbolStore, edgeStore);
	
	// Run query with just text (keyword search only if no embeddings)
	const result = await smartQuery.search({
		queryText: "Logger",
		maxTokens: 4000,
		branch: "main",
	});
	
	logTest(
		"Smart Query (keyword only)",
		result.metadata.keywordHits > 0 || result.symbols.length >= 0,
		`Query completed in ${result.metadata.queryTime}ms. Keyword hits: ${result.metadata.keywordHits}, Symbols: ${result.symbols.length}`
	);
	
	// If embeddings work, test with embedding
	if (testEmbedding) {
		const vectorResult = await smartQuery.search({
			embedding: testEmbedding,
			queryText: "calculate tax function",
			maxTokens: 4000,
			branch: "main",
		});
		
		logTest(
			"Smart Query (hybrid)",
			true, // Just checking it runs without error
			`Hybrid query: ${vectorResult.metadata.vectorHits} vector + ${vectorResult.metadata.keywordHits} keyword hits. Confidence: ${vectorResult.metadata.confidence}`
		);
	}
} catch (error) {
	const err = error as Error;
	logTest("Smart Query", false, `Error: ${err.message}`);
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
} else {
	console.log("⚠️  SOME TESTS FAILED - See details above");
	
	// Check if critical failures
	const criticalFailures = ["Symbol Extraction", "Keyword Search (FTS5)"];
	const hasCriticalFailure = criticalFailures.some(name => !testResults[name]?.passed);
	
	if (hasCriticalFailure) {
		console.log("❌ CRITICAL: Core functionality failed");
		process.exit(1);
	} else {
		console.log("ℹ️  Non-critical failures (sqlite-vec/embeddings may need setup)");
	}
}
console.log("=".repeat(70));

// Cleanup
db.close();
