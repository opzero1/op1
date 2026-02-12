/**
 * Content FTS Store Tests
 *
 * Tests buildFTS5Query() indirectly through the public ContentFTSStore.search()
 * method using a real in-memory SQLite FTS5 table with porter tokenizer.
 *
 * buildFTS5Query is module-internal (not exported), so we exercise it via
 * the store's search path: search(query) → buildFTS5Query(query) → MATCH.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
	createContentFTSStore,
	type ContentFTSStore,
	type FTSEntry,
} from "../storage/content-fts-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates the fts_content virtual table with porter tokenizer in the given DB.
 * Porter is used here (instead of the production trigram tokenizer) because
 * buildFTS5Query generates quoted-term + prefix queries that pair naturally
 * with word-level tokenizers and stemming.
 */
function createFTSTable(db: Database): void {
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
			content_id,
			content_type,
			file_path,
			name,
			content,
			tokenize='porter'
		);
	`);
}

// ---------------------------------------------------------------------------
// Test data — realistic code index entries
// ---------------------------------------------------------------------------

const TEST_ENTRIES: FTSEntry[] = [
	{
		// #1 — createRecipient in COP currency handler
		content_id: "sym-create-recipient",
		content_type: "symbol",
		file_path: "src/payments/cop-currency-handler.ts",
		name: "createRecipient",
		content: `export async function createRecipient(
  accountId: string,
  currency: 'COP' | 'USD',
  recipientDetails: RecipientDetails
): Promise<Recipient> {
  validateCOPRecipient(recipientDetails);
  return await paymentGateway.register(accountId, currency, recipientDetails);
}`,
	},
	{
		// #2 — getUserById
		content_id: "sym-get-user",
		content_type: "symbol",
		file_path: "src/users/user-service.ts",
		name: "getUserById",
		content: `export function getUserById(id: string): User | undefined {
  if (!id) throw new Error('User ID is required');
  return userRepository.findOne({ where: { id } });
}`,
	},
	{
		// #3 — handleError
		content_id: "sym-handle-error",
		content_type: "symbol",
		file_path: "src/utils/error-handler.ts",
		name: "handleError",
		content: `export function handleError(error: unknown): ApiResponse {
  if (error instanceof ValidationError) return { status: 400, message: error.message };
  if (error instanceof NotFoundError) return { status: 404, message: 'Not found' };
  return { status: 500, message: 'Internal server error' };
}`,
	},
	{
		// #4 — parseConfig
		content_id: "sym-parse-config",
		content_type: "symbol",
		file_path: "src/config/parser.ts",
		name: "parseConfig",
		content: `export function parseConfig(raw: string): AppConfig {
  const parsed = JSON.parse(raw);
  if (!parsed.port || !parsed.host) throw new Error('Missing required config fields');
  return { port: parsed.port, host: parsed.host, debug: parsed.debug ?? false };
}`,
	},
	{
		// #5 — authentication middleware (file-level)
		content_id: "file-auth-middleware",
		content_type: "file",
		file_path: "src/middleware/authentication.ts",
		name: "authentication.ts",
		content: `/**
 * Authentication middleware — verifies JWT tokens and attaches user context.
 */
import { verify } from 'jsonwebtoken';

export function authenticationMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}`,
	},
	{
		// #6 — database connection pool (chunk)
		content_id: "chunk-db-pool",
		content_type: "chunk",
		file_path: "src/database/connection.ts",
		name: "database-connection-pool",
		content: `import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function query(text: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}`,
	},
	{
		// #7 — PaymentService class with COP support
		content_id: "sym-payment-service",
		content_type: "symbol",
		file_path: "src/payments/payment-service.ts",
		name: "PaymentService",
		content: `export class PaymentService {
  private readonly supportedCurrencies = ['USD', 'COP', 'EUR'];

  async createPayment(amount: number, currency: string, recipientId: string) {
    if (!this.supportedCurrencies.includes(currency)) {
      throw new Error('Unsupported currency: ' + currency);
    }
    return this.gateway.processPayment({ amount, currency, recipientId });
  }

  async createRecipient(details: RecipientDetails) {
    return this.gateway.registerRecipient(details);
  }
}`,
	},
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ContentFTSStore — buildFTS5Query integration", () => {
	let db: Database;
	let store: ContentFTSStore;

	beforeAll(() => {
		db = new Database(":memory:");
		createFTSTable(db);

		store = createContentFTSStore(db);
		store.indexMany(TEST_ENTRIES);
	});

	afterAll(() => {
		db.close();
	});

	// 1. Multi-word natural language query
	test("multi-word NL query returns matching results", () => {
		const results = store.search("create recipient COP currency");

		expect(results.length).toBeGreaterThan(0);

		const ids = results.map((r) => r.content_id);
		// Should match the COP handler and/or the PaymentService
		const matchesCOP =
			ids.includes("sym-create-recipient") ||
			ids.includes("sym-payment-service");
		expect(matchesCOP).toBe(true);
	});

	// 2. Single word query
	test("single word query returns results", () => {
		const results = store.search("authentication");

		expect(results.length).toBeGreaterThan(0);

		const ids = results.map((r) => r.content_id);
		expect(ids).toContain("file-auth-middleware");
	});

	// 3. FTS5 operators are filtered out — no syntax errors
	test("FTS5 operator words in query do not throw", () => {
		// "AND" and "OR" are FTS5 reserved — buildFTS5Query strips them
		const results = store.search("create AND delete");

		// Should not throw. "create" survives as a valid token.
		expect(Array.isArray(results)).toBe(true);

		// "create" should still produce matches
		const ids = results.map((r) => r.content_id);
		const hasCreateMatch =
			ids.includes("sym-create-recipient") ||
			ids.includes("sym-payment-service");
		expect(hasCreateMatch).toBe(true);
	});

	// 4. Prefix matching for tokens ≥ 4 chars
	test("partial token (≥ 4 chars) matches via prefix", () => {
		// "recipien" is 8 chars → buildFTS5Query emits "recipien" OR "recipien"*
		const results = store.search("recipien");

		expect(results.length).toBeGreaterThan(0);

		const ids = results.map((r) => r.content_id);
		const matchesRecipient =
			ids.includes("sym-create-recipient") ||
			ids.includes("sym-payment-service");
		expect(matchesRecipient).toBe(true);
	});

	// 5. Short tokens (< 2 chars) are ignored
	test("short tokens under 2 chars are ignored", () => {
		// "a" and "b" are < 2 chars → stripped; "create" survives
		const results = store.search("a b create");

		expect(results.length).toBeGreaterThan(0);

		const ids = results.map((r) => r.content_id);
		const hasCreateMatch =
			ids.includes("sym-create-recipient") ||
			ids.includes("sym-payment-service");
		expect(hasCreateMatch).toBe(true);
	});

	// 6. Empty query returns empty array
	test("empty query returns empty array", () => {
		const results = store.search("");
		expect(results).toEqual([]);
	});

	// 7. All-operator query returns empty array
	test("query containing only FTS5 operators returns empty", () => {
		const results = store.search("AND OR NOT");
		expect(results).toEqual([]);
	});

	// 8. Special FTS5 characters are removed
	test("special FTS5 chars in query are safely removed", () => {
		// Double quotes around "create" and parens around (recipient)
		const resultsQuoted = store.search('"create" recipient');
		expect(resultsQuoted.length).toBeGreaterThan(0);

		const resultsParens = store.search("create (recipient)");
		expect(resultsParens.length).toBeGreaterThan(0);

		// Both should find the same entries
		const idsQuoted = new Set(resultsQuoted.map((r) => r.content_id));
		const idsParens = new Set(resultsParens.map((r) => r.content_id));

		// At minimum, the COP handler or PaymentService should appear in both
		const sharedMatch =
			(idsQuoted.has("sym-create-recipient") &&
				idsParens.has("sym-create-recipient")) ||
			(idsQuoted.has("sym-payment-service") &&
				idsParens.has("sym-payment-service"));
		expect(sharedMatch).toBe(true);
	});

	// 9. contentType filter restricts results
	test("contentType filter only returns matching type", () => {
		// "payment" appears in symbol entries and possibly others
		const symbolOnly = store.search("payment", { contentType: "symbol" });
		const allTypes = store.search("payment");

		expect(symbolOnly.length).toBeGreaterThan(0);

		// Every result must be a symbol
		for (const result of symbolOnly) {
			expect(result.content_type).toBe("symbol");
		}

		// Filtered set should be ≤ unfiltered set
		expect(symbolOnly.length).toBeLessThanOrEqual(allTypes.length);
	});

	// 10. Phrase-like multi-word queries match individual terms
	test("multi-word query matches entries containing individual terms", () => {
		// "database connection" — both words appear in entry #6
		const results = store.search("database connection");

		expect(results.length).toBeGreaterThan(0);

		const ids = results.map((r) => r.content_id);
		expect(ids).toContain("chunk-db-pool");
	});

	// -----------------------------------------------------------------------
	// Bonus edge-case coverage
	// -----------------------------------------------------------------------

	test("single char query returns empty (all tokens too short)", () => {
		const results = store.search("x");
		expect(results).toEqual([]);
	});

	test("limit option caps result count", () => {
		// Use a broad query that could match many entries
		const results = store.search("function", { limit: 2 });
		expect(results.length).toBeLessThanOrEqual(2);
	});

	test("search results include rank field", () => {
		const results = store.search("getUserById");

		expect(results.length).toBeGreaterThan(0);
		for (const result of results) {
			expect(typeof result.rank).toBe("number");
		}
	});

	test("NEAR operator word is stripped without error", () => {
		// "NEAR" is also an FTS5 operator
		const results = store.search("NEAR payment");

		expect(Array.isArray(results)).toBe(true);
		// "payment" should still match
		expect(results.length).toBeGreaterThan(0);
	});

	test("count returns total indexed entries", () => {
		expect(store.count()).toBe(TEST_ENTRIES.length);
	});

	test("countByContentType returns correct counts", () => {
		const symbolCount = store.countByContentType("symbol");
		const fileCount = store.countByContentType("file");
		const chunkCount = store.countByContentType("chunk");

		expect(symbolCount).toBe(
			TEST_ENTRIES.filter((e) => e.content_type === "symbol").length,
		);
		expect(fileCount).toBe(
			TEST_ENTRIES.filter((e) => e.content_type === "file").length,
		);
		expect(chunkCount).toBe(
			TEST_ENTRIES.filter((e) => e.content_type === "chunk").length,
		);
	});
});
