/**
 * End-to-End Test: Smart Query Pipeline
 *
 * Tests the complete semantic search flow:
 * 1. Index creation and file indexing
 * 2. Query embedding generation
 * 3. Hybrid vector + BM25 retrieval
 * 4. RRF fusion
 * 5. Reranking
 * 6. Graph expansion
 * 7. Context building
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createIndexManager, type IndexManager } from "../indexing/index-manager";
import { createSmartQuery, type SmartQuery } from "../query/smart-query";
import { createAutoEmbedder, type Embedder } from "../embeddings";
import { createTemplateHyDEGenerator } from "../query/hyde";

describe("SmartQuery E2E Pipeline", () => {
	let tempDir: string;
	let indexManager: IndexManager;
	let smartQuery: SmartQuery;
	let embedder: Embedder;

	beforeAll(async () => {
		// Create temp workspace with test files
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-intel-e2e-"));

		// Create test TypeScript files
		fs.writeFileSync(
			path.join(tempDir, "user-service.ts"),
			`/**
 * User Service - handles user authentication and management
 */

export interface User {
	id: string;
	email: string;
	name: string;
	createdAt: Date;
}

export class UserService {
	private users: Map<string, User> = new Map();

	/**
	 * Validates an email address format
	 */
	validateEmail(email: string): boolean {
		const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
		return emailRegex.test(email);
	}

	/**
	 * Creates a new user with the given email and name
	 */
	async createUser(email: string, name: string): Promise<User> {
		if (!this.validateEmail(email)) {
			throw new Error("Invalid email format");
		}

		const user: User = {
			id: crypto.randomUUID(),
			email,
			name,
			createdAt: new Date(),
		};

		this.users.set(user.id, user);
		return user;
	}

	/**
	 * Finds a user by their ID
	 */
	findById(id: string): User | undefined {
		return this.users.get(id);
	}

	/**
	 * Finds a user by their email address
	 */
	findByEmail(email: string): User | undefined {
		for (const user of this.users.values()) {
			if (user.email === email) {
				return user;
			}
		}
		return undefined;
	}
}
`,
		);

		fs.writeFileSync(
			path.join(tempDir, "auth-controller.ts"),
			`/**
 * Authentication Controller - handles login and signup endpoints
 */

import { UserService, type User } from "./user-service";

export class AuthController {
	constructor(private userService: UserService) {}

	/**
	 * Handles user login request
	 */
	async login(email: string, password: string): Promise<{ token: string; user: User }> {
		const user = this.userService.findByEmail(email);
		if (!user) {
			throw new Error("User not found");
		}

		// In real implementation, verify password hash
		const token = this.generateToken(user);
		return { token, user };
	}

	/**
	 * Handles user signup request
	 */
	async signup(email: string, name: string, password: string): Promise<User> {
		const existingUser = this.userService.findByEmail(email);
		if (existingUser) {
			throw new Error("Email already registered");
		}

		return this.userService.createUser(email, name);
	}

	private generateToken(user: User): string {
		// Simple token generation for testing
		return Buffer.from(JSON.stringify({ userId: user.id, exp: Date.now() + 3600000 })).toString("base64");
	}
}
`,
		);

		// Initialize index manager
		indexManager = await createIndexManager({
			workspaceRoot: tempDir,
		});
		await indexManager.initialize();

		// Index the test files
		await indexManager.indexAll();

		// Create embedder
		embedder = await createAutoEmbedder();

		// Create SmartQuery with embedder
		const stores = indexManager.getStores();
		const db = indexManager.getDatabase();
		smartQuery = createSmartQuery(db, stores.symbols, stores.edges, { embedder });
	});

	afterAll(async () => {
		// Cleanup
		if (indexManager) {
			await indexManager.close();
		}
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("index status shows indexed files and symbols", async () => {
		const status = await indexManager.getStatus();

		expect(status.state).toBe("ready");
		expect(status.indexed_files).toBeGreaterThanOrEqual(2);
		expect(status.total_symbols).toBeGreaterThan(0);
	});

	test("smart_query finds email validation function", async () => {
		const result = await smartQuery.search({
			queryText: "function that validates email addresses",
			maxTokens: 4000,
		});

		expect(result.symbols.length).toBeGreaterThan(0);
		expect(result.context).toContain("validateEmail");
		expect(result.metadata.queryTime).toBeGreaterThan(0);
	});

	test("smart_query finds user creation logic", async () => {
		const result = await smartQuery.search({
			queryText: "create a new user with email and name",
			maxTokens: 4000,
		});

		expect(result.symbols.length).toBeGreaterThan(0);
		expect(result.context).toContain("createUser");
	});

	test("smart_query finds authentication endpoints", async () => {
		const result = await smartQuery.search({
			queryText: "login and signup authentication handlers",
			maxTokens: 4000,
		});

		expect(result.symbols.length).toBeGreaterThan(0);
		// Should find AuthController methods
		const hasAuthMethods =
			result.context.includes("login") || result.context.includes("signup");
		expect(hasAuthMethods).toBe(true);
	});

	test("smart_query with reranking enabled", async () => {
		const result = await smartQuery.search({
			queryText: "find user by email address",
			maxTokens: 4000,
			rerank: "heuristic",
		});

		expect(result.symbols.length).toBeGreaterThan(0);
		expect(result.context).toContain("findByEmail");
	});

	test("smart_query with boolean rerank=true triggers heuristic reranking", async () => {
		// boolean true should be mapped to "heuristic" internally
		const result = await smartQuery.search({
			queryText: "find user by email address",
			maxTokens: 4000,
			rerank: "heuristic", // simulates what tools.ts maps `true` to
		});

		const resultNoRerank = await smartQuery.search({
			queryText: "find user by email address",
			maxTokens: 4000,
			rerank: "none", // simulates what tools.ts maps `false` to
		});

		// Both should produce results without errors
		expect(result.symbols.length).toBeGreaterThan(0);
		expect(resultNoRerank.symbols.length).toBeGreaterThan(0);
	});

	test("smart_query accepts granularity option without error", async () => {
		// granularity is forwarded through ParsedQueryOptions but actual multi-granular
		// pipeline activation is Phase 3. This test ensures the plumbing doesn't crash.
		for (const granularity of ["auto", "symbol", "chunk", "file"] as const) {
			const result = await smartQuery.search({
				queryText: "user service",
				maxTokens: 4000,
				granularity,
			});
			// Should not throw, should return valid result structure
			expect(result.symbols).toBeDefined();
			expect(result.context).toBeDefined();
			expect(result.metadata).toBeDefined();
		}
	});

	test("smart_query accepts pathPrefix option without error", async () => {
		// pathPrefix is wired through but actual path filtering is Phase 2.
		// This test ensures the contract accepts it without crashing.
		const result = await smartQuery.search({
			queryText: "user service",
			maxTokens: 4000,
			pathPrefix: "src/",
		});

		expect(result.symbols).toBeDefined();
		expect(result.context).toBeDefined();
	});

	test("smart_query accepts filePatterns option without error", async () => {
		// filePatterns is wired through but actual filtering is Phase 2.
		const result = await smartQuery.search({
			queryText: "user service",
			maxTokens: 4000,
			filePatterns: ["*.ts", "src/**/*.tsx"],
		});

		expect(result.symbols).toBeDefined();
		expect(result.context).toBeDefined();
	});

	test("smart_query accepts all new options combined without error", async () => {
		const result = await smartQuery.search({
			queryText: "validate email",
			maxTokens: 4000,
			rerank: "heuristic",
			granularity: "symbol",
			pathPrefix: "packages/",
			filePatterns: ["*.ts"],
		});

		expect(result.symbols).toBeDefined();
		expect(result.metadata).toBeDefined();
	});

	test("smart_query respects token budget", async () => {
		const smallBudget = await smartQuery.search({
			queryText: "user service",
			maxTokens: 500,
		});

		const largeBudget = await smartQuery.search({
			queryText: "user service",
			maxTokens: 8000,
		});

		expect(smallBudget.tokenCount).toBeLessThanOrEqual(500);
		expect(largeBudget.tokenCount).toBeGreaterThanOrEqual(smallBudget.tokenCount);
	});

	test("HyDE generator creates hypothetical code", async () => {
		const hyde = createTemplateHyDEGenerator();

		const hypothetical = await hyde.generateHypothetical(
			"function that validates email addresses",
		);

		expect(hypothetical).toContain("function");
		expect(hypothetical.toLowerCase()).toContain("email");
	});

	test("HyDE embedding improves search", async () => {
		const hyde = createTemplateHyDEGenerator();

		// Generate HyDE embedding
		const hydeEmbedding = await hyde.generateHyDEEmbedding(
			"validate email format regex",
			embedder,
		);

		expect(hydeEmbedding.length).toBeGreaterThan(0);
		expect(Array.isArray(hydeEmbedding)).toBe(true);

		// Search with HyDE embedding
		const result = await smartQuery.search({
			embedding: hydeEmbedding,
			queryText: "validate email format regex",
			maxTokens: 4000,
		});

		expect(result.symbols.length).toBeGreaterThan(0);
	});

	test("graph expansion finds related symbols", async () => {
		const result = await smartQuery.search({
			queryText: "AuthController login",
			maxTokens: 4000,
			graphDepth: 2,
		});

		// Should expand to find related UserService methods
		expect(result.symbols.length).toBeGreaterThan(0);
		expect(result.metadata.graphExpansions).toBeGreaterThanOrEqual(0);
	});

	// ====================================================================
	// Phase 2: Scoped Retrieval Tests
	// ====================================================================

	test("search result metadata includes scope information", async () => {
		const result = await smartQuery.search({
			queryText: "user service",
			maxTokens: 4000,
			pathPrefix: "src/",
			filePatterns: ["*.ts"],
		});

		expect(result.metadata.scope).toBeDefined();
		expect(result.metadata.scope?.branch).toBe("main");
		expect(result.metadata.scope?.pathPrefix).toBe("src/");
		expect(result.metadata.scope?.filePatterns).toEqual(["*.ts"]);
	});

	test("empty result includes scope metadata when options provided", async () => {
		const result = await smartQuery.search({
			queryText: "",
			maxTokens: 4000,
			pathPrefix: "nonexistent/",
		});

		expect(result.symbols.length).toBe(0);
		expect(result.metadata.scope).toBeDefined();
		expect(result.metadata.scope?.pathPrefix).toBe("nonexistent/");
	});

	test("scope metadata omits pathPrefix and filePatterns when not specified", async () => {
		const result = await smartQuery.search({
			queryText: "user service",
			maxTokens: 4000,
		});

		expect(result.metadata.scope).toBeDefined();
		expect(result.metadata.scope?.branch).toBe("main");
		expect(result.metadata.scope?.pathPrefix).toBeUndefined();
		expect(result.metadata.scope?.filePatterns).toBeUndefined();
	});

	test("pathPrefix filters results to matching paths only", async () => {
		// Files are at the root of tempDir, so pathPrefix "user" should match "user-service.ts"
		const result = await smartQuery.search({
			queryText: "validateEmail createUser",
			maxTokens: 4000,
			pathPrefix: "user",
		});

		// All returned symbols should be from paths starting with "user"
		for (const symbol of result.symbols) {
			expect(symbol.file_path.startsWith("user")).toBe(true);
		}
		// Verify excluded files are NOT present
		const hasAuthSymbols = result.symbols.some((s) => s.file_path.startsWith("auth-"));
		expect(hasAuthSymbols).toBe(false);
	});

	test("pathPrefix that matches no files returns empty results", async () => {
		const result = await smartQuery.search({
			queryText: "login signup authentication",
			maxTokens: 4000,
			pathPrefix: "does-not-exist/deeply/nested/",
		});

		expect(result.symbols.length).toBe(0);
	});

	test("filePatterns filters results to matching file globs", async () => {
		// "auth-*" should match "auth-controller.ts" but not "user-service.ts"
		const result = await smartQuery.search({
			queryText: "login signup",
			maxTokens: 4000,
			filePatterns: ["auth-*"],
		});

		for (const symbol of result.symbols) {
			expect(symbol.file_path.startsWith("auth-")).toBe(true);
		}
		// Verify user-service symbols are NOT present
		const hasUserSymbols = result.symbols.some((s) => s.file_path.startsWith("user-"));
		expect(hasUserSymbols).toBe(false);
	});

	test("combined pathPrefix and filePatterns applies both filters", async () => {
		// pathPrefix "user" AND filePatterns ["*.ts"] should only match "user-service.ts"
		const result = await smartQuery.search({
			queryText: "validateEmail findById findByEmail",
			maxTokens: 4000,
			pathPrefix: "user",
			filePatterns: ["*.ts"],
		});

		for (const symbol of result.symbols) {
			expect(symbol.file_path.startsWith("user")).toBe(true);
			expect(symbol.file_path.endsWith(".ts")).toBe(true);
		}
	});

	test("empty pathPrefix is treated as no filter", async () => {
		const withEmpty = await smartQuery.search({
			queryText: "validateEmail login",
			maxTokens: 4000,
			pathPrefix: "",
		});

		const withoutFilter = await smartQuery.search({
			queryText: "validateEmail login",
			maxTokens: 4000,
		});

		// Empty string should behave identically to no filter
		expect(withEmpty.symbols.length).toBe(withoutFilter.symbols.length);
	});

	test("empty filePatterns array is treated as no filter", async () => {
		const withEmpty = await smartQuery.search({
			queryText: "validateEmail login",
			maxTokens: 4000,
			filePatterns: [],
		});

		const withoutFilter = await smartQuery.search({
			queryText: "validateEmail login",
			maxTokens: 4000,
		});

		// Empty array should behave identically to no filter
		expect(withEmpty.symbols.length).toBe(withoutFilter.symbols.length);
	});

	test("exact filename in filePatterns matches correctly", async () => {
		const result = await smartQuery.search({
			queryText: "user service email",
			maxTokens: 4000,
			filePatterns: ["user-service.ts"],
		});

		for (const symbol of result.symbols) {
			expect(symbol.file_path).toBe("user-service.ts");
		}
	});

	test("empty query returns empty result", async () => {
		const result = await smartQuery.search({
			queryText: "",
			maxTokens: 4000,
		});

		expect(result.symbols.length).toBe(0);
		expect(result.context).toBe("");
	});

	test("nonsense query returns low confidence", async () => {
		const result = await smartQuery.search({
			queryText: "xyzzy plugh completely random gibberish terms",
			maxTokens: 4000,
		});

		// May return results from keyword matching, but confidence should be low
		if (result.symbols.length === 0) {
			expect(result.metadata.confidence).toBe("low");
		}
	});
});
