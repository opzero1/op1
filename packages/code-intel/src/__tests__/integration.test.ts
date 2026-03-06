/**
 * Integration tests for @op1/code-intel
 *
 * Tests core functionality end-to-end:
 * 1. Module exports
 * 2. Storage layer (SQLite)
 * 3. Symbol extraction
 * 4. Query engine
 * 5. Diagnostics
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	createCodeIntelMetrics,
	createLogger,
	createMetricsRegistry,
	nullLogger,
} from "../diagnostics";
import {
	createPythonAdapter,
	createTypeScriptAdapter,
	generateCanonicalId,
} from "../extraction";
import { createBranchManager } from "../indexing";

import {
	createBranchDiffer,
	createGraphExpander,
	createImpactAnalyzer,
} from "../query";
import {
	createEdgeStore,
	createFileStore,
	createKeywordStore,
	createRepoMapStore,
	createSymbolStore,
	type EdgeStore,
	type FileStore,
	type SymbolStore,
} from "../storage";
// Import all modules to verify exports
import {
	DEFAULT_CONFIG,
	type FileRecord,
	type SymbolEdge,
	// Types
	type SymbolNode,
} from "../types";

describe("Module Exports", () => {
	test("types are exported correctly", () => {
		expect(DEFAULT_CONFIG).toBeDefined();
		expect(DEFAULT_CONFIG.dbPath).toBe(".opencode/code-intel/index.db");
		expect(DEFAULT_CONFIG.embeddingDimensions).toBe(768);
	});

	test("storage factories are exported", () => {
		expect(typeof createSymbolStore).toBe("function");
		expect(typeof createEdgeStore).toBe("function");
		expect(typeof createFileStore).toBe("function");
		expect(typeof createKeywordStore).toBe("function");
		expect(typeof createRepoMapStore).toBe("function");
	});

	test("extraction factories are exported", () => {
		expect(typeof generateCanonicalId).toBe("function");
		expect(typeof createTypeScriptAdapter).toBe("function");
		expect(typeof createPythonAdapter).toBe("function");
	});

	test("query factories are exported", () => {
		expect(typeof createGraphExpander).toBe("function");
		expect(typeof createImpactAnalyzer).toBe("function");
		expect(typeof createBranchDiffer).toBe("function");
	});

	test("diagnostics are exported", () => {
		expect(typeof createLogger).toBe("function");
		expect(typeof createMetricsRegistry).toBe("function");
		expect(typeof createCodeIntelMetrics).toBe("function");
		expect(nullLogger).toBeDefined();
	});

	test("indexing factories are exported", () => {
		expect(typeof createBranchManager).toBe("function");
	});
});

describe("Canonical ID Generation", () => {
	test("generates consistent IDs for same input", () => {
		const id1 = generateCanonicalId(
			"src/utils.ts:calculateTax",
			"function(amount: number): number",
			"typescript",
		);
		const id2 = generateCanonicalId(
			"src/utils.ts:calculateTax",
			"function(amount: number): number",
			"typescript",
		);
		expect(id1).toBe(id2);
	});

	test("generates different IDs for different inputs", () => {
		const id1 = generateCanonicalId(
			"src/utils.ts:calculateTax",
			undefined,
			"typescript",
		);
		const id2 = generateCanonicalId(
			"src/utils.ts:calculateTotal",
			undefined,
			"typescript",
		);
		expect(id1).not.toBe(id2);
	});

	test("generates 16-char hex string", () => {
		const id = generateCanonicalId("file.ts:symbol", undefined, "typescript");
		expect(id).toMatch(/^[a-f0-9]{16}$/);
	});
});

describe("Storage Layer", () => {
	let db: Database;
	let symbolStore: SymbolStore;
	let edgeStore: EdgeStore;
	let fileStore: FileStore;

	beforeAll(() => {
		db = new Database(":memory:");

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

		symbolStore = createSymbolStore(db);
		edgeStore = createEdgeStore(db);
		fileStore = createFileStore(db);
	});

	afterAll(() => {
		db.close();
	});

	test("symbol store: upsert and retrieve", () => {
		const symbol: SymbolNode = {
			id: generateCanonicalId("test.ts:testFunc", undefined, "typescript"),
			name: "testFunc",
			qualified_name: "test.ts:testFunc",
			type: "FUNCTION",
			language: "typescript",
			file_path: "test.ts",
			start_line: 1,
			end_line: 5,
			content: "function testFunc() { return 42; }",
			content_hash: "abc123",
			is_external: false,
			branch: "main",
			updated_at: Date.now(),
			revision_id: 1,
		};

		symbolStore.upsert(symbol);
		const retrieved = symbolStore.getById(symbol.id);

		expect(retrieved).not.toBeNull();
		expect(retrieved!.name).toBe("testFunc");
		expect(retrieved!.type).toBe("FUNCTION");
	});

	test("symbol store: count by branch", () => {
		const count = symbolStore.count("main");
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test("edge store: upsert and retrieve", () => {
		const edge: SymbolEdge = {
			id: "edge-001",
			source_id: "source-001",
			target_id: "target-001",
			type: "CALLS",
			confidence: 0.95,
			origin: "ast-inference",
			branch: "main",
			updated_at: Date.now(),
		};

		edgeStore.upsert(edge);
		const retrieved = edgeStore.getById(edge.id);

		expect(retrieved).not.toBeNull();
		expect(retrieved!.type).toBe("CALLS");
		expect(retrieved!.confidence).toBe(0.95);
	});

	test("file store: upsert and retrieve", () => {
		const file: FileRecord = {
			file_path: "src/index.ts",
			file_hash: "hash123",
			mtime: Date.now(),
			size: 1024,
			last_indexed: Date.now(),
			language: "typescript",
			branch: "main",
			status: "indexed",
			symbol_count: 5,
		};

		fileStore.upsert(file);
		const retrieved = fileStore.getByPath("src/index.ts", "main");

		expect(retrieved).not.toBeNull();
		expect(retrieved!.status).toBe("indexed");
		expect(retrieved!.symbol_count).toBe(5);
	});
});

describe("TypeScript Adapter", () => {
	test("extracts functions", async () => {
		const adapter = createTypeScriptAdapter();
		const code = `
export function calculateTax(amount: number): number {
	return amount * 0.1;
}
`;
		const symbols = await adapter.extractSymbols(code, "tax.ts");

		expect(symbols.length).toBeGreaterThanOrEqual(1);
		const func = symbols.find(
			(s: { name: string }) => s.name === "calculateTax",
		);
		expect(func).toBeDefined();
		expect(func!.type).toBe("FUNCTION");
	});

	test("extracts classes", async () => {
		const adapter = createTypeScriptAdapter();
		const code = `
export class UserService {
	private users: User[] = [];
	
	getUser(id: string): User | undefined {
		return this.users.find(u => u.id === id);
	}
}
`;
		const symbols = await adapter.extractSymbols(code, "user-service.ts");

		const cls = symbols.find((s: { name: string }) => s.name === "UserService");
		expect(cls).toBeDefined();
		expect(cls!.type).toBe("CLASS");
	});

	test("extracts interfaces", async () => {
		const adapter = createTypeScriptAdapter();
		const code = `
export interface Config {
	name: string;
	value: number;
}
`;
		const symbols = await adapter.extractSymbols(code, "config.ts");

		const iface = symbols.find((s: { name: string }) => s.name === "Config");
		expect(iface).toBeDefined();
		expect(iface!.type).toBe("INTERFACE");
	});
});

describe("Python Adapter", () => {
	test("extracts functions", async () => {
		const adapter = createPythonAdapter();
		const code = `
def calculate_tax(amount: float) -> float:
    """Calculate tax for given amount."""
    return amount * 0.1
`;
		const symbols = await adapter.extractSymbols(code, "tax.py");

		const func = symbols.find(
			(s: { name: string }) => s.name === "calculate_tax",
		);
		expect(func).toBeDefined();
		expect(func!.type).toBe("FUNCTION");
		expect(func!.docstring).toContain("Calculate tax");
	});

	test("extracts classes", async () => {
		const adapter = createPythonAdapter();
		const code = `
class UserService:
    """Service for managing users."""
    
    def __init__(self):
        self.users = []
    
    def get_user(self, user_id: str):
        return next((u for u in self.users if u.id == user_id), None)
`;
		const symbols = await adapter.extractSymbols(code, "user_service.py");

		const cls = symbols.find((s: { name: string }) => s.name === "UserService");
		expect(cls).toBeDefined();
		expect(cls!.type).toBe("CLASS");
	});
});

describe("Diagnostics", () => {
	test("logger creates child loggers", () => {
		const logger = createLogger({ console: false, storeEntries: true });
		const child = logger.child({ module: "test" });

		child.info("Test message");
		const entries = child.getEntries();

		expect(entries.length).toBe(1);
		expect(entries[0].context?.module).toBe("test");
	});

	test("metrics registry tracks counters", () => {
		const registry = createMetricsRegistry();
		const counter = registry.counter("test_counter");

		counter.inc();
		counter.inc();
		counter.add(5);

		expect(counter.get()).toBe(7);
	});

	test("metrics registry tracks gauges", () => {
		const registry = createMetricsRegistry();
		const gauge = registry.gauge("test_gauge");

		gauge.set(100);
		gauge.inc();
		gauge.dec();

		expect(gauge.get()).toBe(100);
	});

	test("metrics registry tracks histograms", () => {
		const registry = createMetricsRegistry();
		const histogram = registry.histogram("test_histogram");

		histogram.observe(10);
		histogram.observe(20);
		histogram.observe(30);

		const stats = histogram.getStats();
		expect(stats.count).toBe(3);
		expect(stats.avg).toBe(20);
		expect(stats.min).toBe(10);
		expect(stats.max).toBe(30);
	});

	test("timer measures duration", async () => {
		const registry = createMetricsRegistry();
		const timer = registry.timer("test_timer");

		await timer.time(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});

		const stats = timer.getHistogram().getStats();
		expect(stats.count).toBe(1);
		expect(stats.avg).toBeGreaterThan(5); // At least 5ms
	});

	test("code intel metrics has all counters", () => {
		const metrics = createCodeIntelMetrics();

		expect(metrics.filesIndexed).toBeDefined();
		expect(metrics.symbolsExtracted).toBeDefined();
		expect(metrics.queriesExecuted).toBeDefined();
		expect(metrics.cacheHits).toBeDefined();
	});
});

describe("Branch Manager", () => {
	test("detects git repository", async () => {
		const manager = createBranchManager(process.cwd());
		const isGit = await manager.isGitRepo();

		// We're running from a git repo
		expect(typeof isGit).toBe("boolean");
	});

	test("gets current branch", async () => {
		const manager = createBranchManager(process.cwd());
		const branch = await manager.getCurrentBranch();

		expect(typeof branch).toBe("string");
		expect(branch.length).toBeGreaterThan(0);
	});
});

describe("Branch Diff", () => {
	let db: Database;

	beforeAll(() => {
		db = new Database(":memory:");

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

		// Insert test data for main branch
		const symbolStore = createSymbolStore(db);
		symbolStore.upsert({
			id: "sym-1",
			name: "sharedFunc",
			qualified_name: "shared.ts:sharedFunc",
			type: "FUNCTION",
			language: "typescript",
			file_path: "shared.ts",
			start_line: 1,
			end_line: 5,
			content: "function sharedFunc() { return 1; }",
			content_hash: "hash-main",
			is_external: false,
			branch: "main",
			updated_at: Date.now(),
			revision_id: 1,
		});

		// Insert test data for feature branch (modified)
		symbolStore.upsert({
			id: "sym-1-feature",
			name: "sharedFunc",
			qualified_name: "shared.ts:sharedFunc",
			type: "FUNCTION",
			language: "typescript",
			file_path: "shared.ts",
			start_line: 1,
			end_line: 5,
			content: "function sharedFunc() { return 2; }",
			content_hash: "hash-feature", // Different hash
			is_external: false,
			branch: "feature",
			updated_at: Date.now(),
			revision_id: 2,
		});

		// Add a symbol only in feature branch
		symbolStore.upsert({
			id: "sym-2",
			name: "newFunc",
			qualified_name: "new.ts:newFunc",
			type: "FUNCTION",
			language: "typescript",
			file_path: "new.ts",
			start_line: 1,
			end_line: 3,
			content: "function newFunc() {}",
			content_hash: "hash-new",
			is_external: false,
			branch: "feature",
			updated_at: Date.now(),
			revision_id: 1,
		});
	});

	afterAll(() => {
		db.close();
	});

	test("detects added symbols", () => {
		const differ = createBranchDiffer(db);
		const added = differ.getAddedSymbols("feature", "main");

		expect(added.length).toBe(1);
		expect(added[0].name).toBe("newFunc");
	});

	test("detects modified symbols", () => {
		const differ = createBranchDiffer(db);
		const modified = differ.getModifiedSymbols("feature", "main");

		expect(modified.length).toBe(1);
		expect(modified[0].source.content).toContain("return 2");
		expect(modified[0].target.content).toContain("return 1");
	});

	test("full diff includes all changes", () => {
		const differ = createBranchDiffer(db);
		const diff = differ.diff("feature", "main");

		expect(diff.sourceBranch).toBe("feature");
		expect(diff.targetBranch).toBe("main");
		expect(diff.symbols.summary.added).toBe(1);
		expect(diff.symbols.summary.modified).toBe(1);
		expect(diff.computeTime).toBeGreaterThan(0);
	});
});

console.log("All integration tests defined successfully!");
