#!/usr/bin/env bun
/**
 * @op1/code-intel - SEMANTIC SEARCH SHOWCASE
 *
 * Demonstrates meaningful semantic code search use cases:
 *
 * 1. 🔍 "How does embedding work?" - Find embedding-related code
 * 2. 🔍 "Where is error handling?" - Find error/logging patterns
 * 3. 🔍 "How do I add a new language?" - Find adapter patterns
 * 4. 🔍 "What stores data?" - Find storage implementations
 *
 * Run: bun run src/__tests__/showcase-demo.ts
 */

import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAutoEmbedder } from "../embeddings";

import {
	createTypeScriptAdapter,
	generateCanonicalId,
	generateContentHash,
} from "../extraction";
import { createSmartQuery } from "../query/smart-query";
// Imports from the package
import {
	createEdgeStore,
	createKeywordStore,
	createPureVectorStore,
	createSymbolStore,
} from "../storage";

import type { SymbolNode, SymbolType } from "../types";

// ============================================================================
// UTILITIES
// ============================================================================

const C = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	bgBlue: "\x1b[44m",
	bgMagenta: "\x1b[45m",
	bgGreen: "\x1b[42m",
};

function banner(text: string) {
	console.log("\n" + C.bgMagenta + C.bright + ` ${text} ` + C.reset);
}

function header(text: string) {
	console.log("\n" + C.bgBlue + C.bright + ` ${text} ` + C.reset);
	console.log(C.blue + "─".repeat(70) + C.reset);
}

function query(text: string) {
	console.log("\n" + C.bgGreen + C.bright + ` 🔍 QUERY: "${text}" ` + C.reset);
}

function result(
	rank: number,
	name: string,
	type: string,
	file: string,
	line: number,
	similarity?: number,
) {
	const simStr =
		similarity !== undefined ? ` (sim: ${similarity.toFixed(3)})` : "";
	console.log(
		C.yellow +
			`  ${rank}. ` +
			C.reset +
			C.bright +
			name +
			C.reset +
			C.dim +
			` [${type}]` +
			C.reset +
			C.cyan +
			simStr +
			C.reset,
	);
	console.log(C.dim + `     ${file}:${line}` + C.reset);
}

function code(content: string, maxLines = 6) {
	const lines = content.split("\n").slice(0, maxLines);
	console.log(C.dim + "     ┌" + "─".repeat(60) + C.reset);
	for (const line of lines) {
		const truncated = line.length > 58 ? line.slice(0, 55) + "..." : line;
		console.log(C.dim + "     │ " + C.reset + truncated);
	}
	if (content.split("\n").length > maxLines) {
		console.log(
			C.dim +
				"     │ " +
				C.yellow +
				`... ${content.split("\n").length - maxLines} more lines` +
				C.reset,
		);
	}
	console.log(C.dim + "     └" + "─".repeat(60) + C.reset);
}

function info(text: string) {
	console.log(C.dim + "  " + text + C.reset);
}

function success(text: string) {
	console.log(C.green + "  ✓ " + text + C.reset);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	banner("@op1/code-intel - SEMANTIC SEARCH SHOWCASE");
	console.log(
		C.dim + "  Demonstrating meaningful code search use cases\n" + C.reset,
	);

	const WORKSPACE_ROOT = process.cwd();

	// ========================================================================
	// SETUP
	// ========================================================================

	header("📦 SETUP: Indexing code-intel source");

	const db = new Database(":memory:");

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
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
			symbol_id,
			name,
			qualified_name,
			content,
			file_path,
			tokenize='trigram'
		)
	`);

	const symbolStore = createSymbolStore(db);
	const edgeStore = createEdgeStore(db);
	const keywordStore = createKeywordStore(db);
	const vectorStore = createPureVectorStore(db);

	// Find TypeScript files
	function findTsFiles(dir: string, files: string[] = []): string[] {
		try {
			for (const entry of readdirSync(dir)) {
				const fullPath = join(dir, entry);
				const stat = statSync(fullPath);
				if (
					stat.isDirectory() &&
					!entry.startsWith(".") &&
					entry !== "node_modules"
				) {
					findTsFiles(fullPath, files);
				} else if (
					entry.endsWith(".ts") &&
					!entry.endsWith(".test.ts") &&
					!entry.includes("showcase")
				) {
					files.push(fullPath);
				}
			}
		} catch {
			/* ignore */
		}
		return files;
	}

	const srcDir = join(WORKSPACE_ROOT, "src");
	const tsFiles = findTsFiles(srcDir);
	info(`Found ${tsFiles.length} TypeScript files`);

	// Extract and index symbols
	const adapter = createTypeScriptAdapter();
	const allSymbols: SymbolNode[] = [];

	for (const fullPath of tsFiles) {
		const filePath = fullPath.replace(WORKSPACE_ROOT + "/", "");
		try {
			const content = await Bun.file(fullPath).text();
			const rawSymbols = await adapter.extractSymbols(content, filePath);

			for (const raw of rawSymbols) {
				const symbol: SymbolNode = {
					id: generateCanonicalId(
						raw.qualified_name,
						raw.signature,
						"typescript",
					),
					name: raw.name,
					qualified_name: raw.qualified_name,
					type: raw.type as SymbolType,
					language: "typescript",
					file_path: filePath,
					start_line: raw.start_line,
					end_line: raw.end_line,
					content: raw.content,
					signature: raw.signature,
					docstring: raw.docstring,
					content_hash: generateContentHash(raw.content),
					is_external: false,
					branch: "main",
					updated_at: Date.now(),
					revision_id: 1,
				};
				allSymbols.push(symbol);
				symbolStore.upsert(symbol);
				keywordStore.index(
					symbol.id,
					symbol.name,
					symbol.qualified_name,
					symbol.content,
					symbol.file_path,
				);
			}
		} catch {
			/* skip */
		}
	}

	success(`Indexed ${allSymbols.length} symbols`);

	// Generate embeddings
	const embedder = await createAutoEmbedder();
	info(`Embedder: ${embedder.modelId}`);

	const embeddingStart = Date.now();
	for (const symbol of allSymbols) {
		const embedding = await embedder.embed(symbol.content);
		vectorStore.upsert(symbol.id, embedding);
	}
	success(
		`Generated ${allSymbols.length} embeddings in ${Date.now() - embeddingStart}ms`,
	);

	const smartQuery = createSmartQuery(db, symbolStore, edgeStore);

	// ========================================================================
	// SEMANTIC SEARCH DEMOS
	// ========================================================================

	header("🧠 SEMANTIC SEARCH DEMONSTRATIONS");

	info("These queries show semantic understanding - finding relevant code");
	info("even when the exact keywords don't match.\n");

	// Demo queries - real developer questions
	const queries = [
		{
			text: "How do I generate embeddings for code?",
			description: "Finding embedding generation logic",
		},
		{
			text: "Where is database storage implemented?",
			description: "Finding SQLite storage patterns",
		},
		{
			text: "How to add support for a new programming language?",
			description: "Finding language adapter patterns",
		},
		{
			text: "What handles logging and debugging?",
			description: "Finding diagnostics/logging code",
		},
		{
			text: "How does the search ranking work?",
			description: "Finding RRF fusion and ranking logic",
		},
	];

	for (const q of queries) {
		query(q.text);
		info(q.description);

		const queryEmbedding = await embedder.embed(q.text);

		const searchResult = await smartQuery.search({
			embedding: queryEmbedding,
			queryText: q.text.split(" ").slice(0, 3).join(" "), // First 3 words for keyword
			maxTokens: 4000,
			branch: "main",
		});

		console.log(
			C.dim +
				`  Found ${searchResult.symbols.length} results in ${searchResult.metadata.queryTime}ms` +
				C.reset +
				C.cyan +
				` (confidence: ${searchResult.metadata.confidence})` +
				C.reset,
		);

		// Show top 3 results with code snippets
		for (let i = 0; i < Math.min(3, searchResult.symbols.length); i++) {
			const s = searchResult.symbols[i];
			result(i + 1, s.name, s.type, s.file_path, s.start_line);
			code(s.content);
		}
	}

	// ========================================================================
	// COMPARISON: Semantic vs Keyword
	// ========================================================================

	header("⚖️ SEMANTIC vs KEYWORD SEARCH COMPARISON");

	const comparisonQuery = "vector similarity calculation";

	query(comparisonQuery);
	info("Comparing semantic search vs pure keyword search\n");

	// Keyword only
	console.log(C.yellow + "  KEYWORD SEARCH (FTS5/BM25):" + C.reset);
	const keywordResults = keywordStore.search("vector", 5);
	if (keywordResults.length === 0) {
		info("  No keyword matches found");
	} else {
		for (let i = 0; i < Math.min(3, keywordResults.length); i++) {
			const r = keywordResults[i];
			const sym = symbolStore.getById(r.symbol_id);
			if (sym) {
				console.log(
					C.dim + `    ${i + 1}. ${sym.name} - ${sym.file_path}` + C.reset,
				);
			}
		}
	}

	// Semantic (vector) search
	console.log(
		"\n" + C.cyan + "  SEMANTIC SEARCH (Vector Similarity):" + C.reset,
	);
	const semanticEmbedding = await embedder.embed(comparisonQuery);
	const vectorResults = vectorStore.search(semanticEmbedding, 5);

	for (let i = 0; i < Math.min(3, vectorResults.length); i++) {
		const r = vectorResults[i];
		const sym = symbolStore.getById(r.symbol_id);
		if (sym) {
			console.log(
				C.green +
					`    ${i + 1}. ${sym.name}` +
					C.reset +
					C.dim +
					` (similarity: ${r.similarity.toFixed(3)}) - ${sym.file_path}` +
					C.reset,
			);
		}
	}

	// Hybrid (best of both)
	console.log("\n" + C.magenta + "  HYBRID SEARCH (RRF Fusion):" + C.reset);
	const hybridResult = await smartQuery.search({
		embedding: semanticEmbedding,
		queryText: "vector",
		maxTokens: 2000,
		branch: "main",
	});

	for (let i = 0; i < Math.min(3, hybridResult.symbols.length); i++) {
		const s = hybridResult.symbols[i];
		console.log(
			C.bright +
				`    ${i + 1}. ${s.name}` +
				C.reset +
				C.dim +
				` [${s.type}] - ${s.file_path}:${s.start_line}` +
				C.reset,
		);
	}

	// ========================================================================
	// SUMMARY
	// ========================================================================

	banner("DEMO COMPLETE");

	console.log(`
  ${C.bright}What you just saw:${C.reset}
  
  ${C.green}✓${C.reset} Semantic search understands ${C.cyan}intent${C.reset}, not just keywords
  ${C.green}✓${C.reset} Query "How to add a new language?" finds ${C.cyan}adapter patterns${C.reset}
  ${C.green}✓${C.reset} Query "database storage" finds ${C.cyan}SQLite implementations${C.reset}
  ${C.green}✓${C.reset} Hybrid search combines ${C.cyan}vector + keyword + ranking${C.reset}
  
  ${C.bright}Run commands:${C.reset}
  ${C.dim}bun run src/__tests__/showcase-demo.ts${C.reset}    # This demo
  ${C.dim}bun run src/__tests__/full-pipeline-v2.test.ts${C.reset}  # Pipeline test
  ${C.dim}bun test${C.reset}                                  # Unit tests
`);

	db.close();
}

main().catch(console.error);
