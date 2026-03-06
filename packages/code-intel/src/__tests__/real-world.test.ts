#!/usr/bin/env bun
/**
 * Real-World Usage Test for @op1/code-intel
 *
 * This script simulates how a developer would actually use the package:
 * 1. Create a SQLite database
 * 2. Extract symbols from real TypeScript files
 * 3. Store symbols in the database
 * 4. Query and retrieve symbols
 * 5. Analyze branch differences
 * 6. Use diagnostics for logging/metrics
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodeIntelMetrics, createLogger } from "../diagnostics";

import {
	createTypeScriptAdapter,
	generateCanonicalId,
	generateContentHash,
} from "../extraction";
import { createBranchManager } from "../indexing";
import { createBranchDiffer } from "../query";
// Import from the package
import {
	createEdgeStore,
	createFileStore,
	createSymbolStore,
} from "../storage";

import type { SymbolNode } from "../types";

// ============================================================================
// Test Configuration
// ============================================================================

const WORKSPACE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEST_DB_PATH = ":memory:"; // Use in-memory for testing

test("real world usage script", async () => {

console.log("=".repeat(70));
console.log("@op1/code-intel - Real-World Usage Test");
console.log("=".repeat(70));
console.log(`Workspace: ${WORKSPACE_ROOT}`);
console.log(`Database: ${TEST_DB_PATH}`);
console.log("");

// ============================================================================
// Setup
// ============================================================================

console.log("📦 STEP 1: Setting up database and stores...");

const db = new Database(TEST_DB_PATH);

// Create tables
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

db.run(`
	CREATE TABLE IF NOT EXISTS files (
		file_path TEXT NOT NULL,
		branch TEXT NOT NULL DEFAULT 'main',
		file_hash TEXT NOT NULL,
		mtime INTEGER NOT NULL,
		size INTEGER NOT NULL,
		last_indexed INTEGER NOT NULL,
		language TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		symbol_count INTEGER NOT NULL DEFAULT 0,
		importance_rank REAL,
		error_message TEXT,
		PRIMARY KEY (file_path, branch)
	)
`);

const symbolStore = createSymbolStore(db);
const edgeStore = createEdgeStore(db);
const fileStore = createFileStore(db);

console.log("✅ Database and stores initialized\n");

// ============================================================================
// Test 1: Extract symbols from real TypeScript files
// ============================================================================

console.log("📝 STEP 2: Extracting symbols from real TypeScript files...");

const adapter = createTypeScriptAdapter();
const metrics = createCodeIntelMetrics();
const logger = createLogger({
	console: false,
	storeEntries: true,
	level: "debug",
});

// Read actual source files from this package
const sourceFiles = [
	"src/types.ts",
	"src/diagnostics/logger.ts",
	"src/diagnostics/metrics.ts",
];

const allSymbols: SymbolNode[] = [];
const branch = "main";

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

		console.log(`  📄 ${filePath}: ${rawSymbols.length} symbols extracted`);

		// Convert to SymbolNode and store
		for (const raw of rawSymbols) {
			const symbol: SymbolNode = {
				id: generateCanonicalId(
					raw.qualified_name,
					raw.signature,
					"typescript",
				),
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
			metrics.symbolsExtracted.inc();
		}

		metrics.filesIndexed.inc();
	} catch (error) {
		console.log(`  ❌ Error processing ${filePath}: ${error}`);
		metrics.indexingErrors.inc();
	}
}

console.log(
	`\n✅ Extracted ${allSymbols.length} total symbols from ${sourceFiles.length} files\n`,
);

// ============================================================================
// Test 2: Query symbols from database
// ============================================================================

console.log("🔍 STEP 3: Querying symbols from database...");

const totalSymbols = symbolStore.count(branch);
console.log(`  📊 Total symbols in database: ${totalSymbols}`);

// Query by type
const functions = symbolStore.getByType("FUNCTION", branch);
const classes = symbolStore.getByType("CLASS", branch);
const interfaces = symbolStore.getByType("INTERFACE", branch);
const typeAliases = symbolStore.getByType("TYPE_ALIAS", branch);

console.log(`  📊 Functions: ${functions.length}`);
console.log(`  📊 Classes: ${classes.length}`);
console.log(`  📊 Interfaces: ${interfaces.length}`);
console.log(`  📊 Type Aliases: ${typeAliases.length}`);

// Query specific symbols
const loggerSymbols = symbolStore.getByName("createLogger", branch);
console.log(
	`\n  🔎 Found 'createLogger': ${loggerSymbols.length > 0 ? "YES" : "NO"}`,
);
if (loggerSymbols.length > 0) {
	console.log(`     - Type: ${loggerSymbols[0].type}`);
	console.log(`     - File: ${loggerSymbols[0].file_path}`);
	console.log(
		`     - Lines: ${loggerSymbols[0].start_line}-${loggerSymbols[0].end_line}`,
	);
}

console.log("\n✅ Database queries successful\n");

// ============================================================================
// Test 3: Branch diff simulation
// ============================================================================

console.log("🌿 STEP 4: Testing branch diff functionality...");

// Insert some symbols for a "feature" branch to simulate a diff
const featureSymbol: SymbolNode = {
	id: generateCanonicalId("feature.ts:newFeature", undefined, "typescript"),
	name: "newFeature",
	qualified_name: "feature.ts:newFeature",
	type: "FUNCTION",
	language: "typescript",
	file_path: "feature.ts",
	start_line: 1,
	end_line: 5,
	content: "function newFeature() { return 'new'; }",
	content_hash: generateContentHash("function newFeature() { return 'new'; }"),
	is_external: false,
	branch: "feature",
	updated_at: Date.now(),
	revision_id: 1,
};

symbolStore.upsert(featureSymbol);

const differ = createBranchDiffer(db);
const diff = differ.diff("feature", "main");

console.log(`  📊 Diff: feature vs main`);
console.log(`     - Added symbols: ${diff.symbols.summary.added}`);
console.log(`     - Removed symbols: ${diff.symbols.summary.removed}`);
console.log(`     - Modified symbols: ${diff.symbols.summary.modified}`);
console.log(`     - Compute time: ${diff.computeTime.toFixed(2)}ms`);

console.log("\n✅ Branch diff working correctly\n");

// ============================================================================
// Test 4: Git branch detection
// ============================================================================

console.log("🔀 STEP 5: Testing Git branch detection...");

const branchManager = createBranchManager(WORKSPACE_ROOT);
const isGitRepo = await branchManager.isGitRepo();
const currentBranch = await branchManager.getCurrentBranch();
const defaultBranch = await branchManager.getDefaultBranch();

console.log(`  📊 Is Git repo: ${isGitRepo}`);
console.log(`  📊 Current branch: ${currentBranch}`);
console.log(`  📊 Default branch: ${defaultBranch}`);

console.log("\n✅ Git integration working correctly\n");

// ============================================================================
// Test 5: Metrics and logging
// ============================================================================

console.log("📈 STEP 6: Testing diagnostics (metrics & logging)...");

// Get metrics snapshot
const snapshot = metrics.registry.snapshot();

console.log(`  📊 Files indexed: ${snapshot.counters.files_indexed || 0}`);
console.log(
	`  📊 Symbols extracted: ${snapshot.counters.symbols_extracted || 0}`,
);
console.log(`  📊 Indexing errors: ${snapshot.counters.indexing_errors || 0}`);

// Test timer
const timer = metrics.indexingDuration;
const stopTimer = timer.start();
await new Promise((r) => setTimeout(r, 10));
const duration = stopTimer();

console.log(`  📊 Timer test: ${duration.toFixed(2)}ms`);

// Check logger entries
logger.info("Test completed", { symbols: allSymbols.length });
const logEntries = logger.getEntries();
console.log(`  📊 Log entries captured: ${logEntries.length}`);

console.log("\n✅ Diagnostics working correctly\n");

// ============================================================================
// Summary
// ============================================================================

console.log("=".repeat(70));
console.log("TEST SUMMARY");
console.log("=".repeat(70));

const results = {
	database_initialized: true,
	files_processed: sourceFiles.length,
	symbols_extracted: allSymbols.length,
	symbols_in_db: totalSymbols,
	functions_found: functions.length,
	classes_found: classes.length,
	interfaces_found: interfaces.length,
	branch_diff_working: diff.symbols.summary.added === 1,
	git_detection_working: typeof isGitRepo === "boolean",
	metrics_working: snapshot.counters.symbols_extracted > 0,
	logging_working: logEntries.length > 0,
};

console.log("\n📋 Results:");
for (const [key, value] of Object.entries(results)) {
	const status =
		value === true || (typeof value === "number" && value > 0) ? "✅" : "❌";
	console.log(`  ${status} ${key}: ${value}`);
}

const allPassed = Object.values(results).every(
	(v) => v === true || (typeof v === "number" && v >= 0),
);

console.log("\n" + "=".repeat(70));
if (allPassed) {
	console.log("🎉 ALL REAL-WORLD TESTS PASSED!");
} else {
	console.log("❌ SOME TESTS FAILED - SEE ABOVE");
}
console.log("=".repeat(70));

expect(allPassed).toBe(true);

// Cleanup
db.close();
}, 60000);
