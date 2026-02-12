import { describe, expect, test } from "bun:test";
import { createQueryRewriter } from "../query/query-rewriter";

// ============================================================================
// Synonym Expansion
// ============================================================================

describe("Synonym expansion", () => {
	const rewriter = createQueryRewriter();

	test("terms with synonyms get OR-grouped", () => {
		const result = rewriter.rewrite("create user");

		// Both "create" and "user" have synonyms → each wrapped in (term OR syn1 OR ...)
		expect(result.expanded).toContain("(create OR add OR new");
		expect(result.expanded).toContain("(user OR account OR profile");

		// Expansions include the synonym terms themselves
		expect(result.expansions.length).toBeGreaterThan(0);
		expect(result.expansions).toContain("add");
		expect(result.expansions).toContain("account");
	});

	test("terms without synonyms stay as bare words", () => {
		const result = rewriter.rewrite("recipient COP currency");

		// None of these terms have entries in CODE_SYNONYMS
		// extractTerms lowercases everything
		expect(result.expanded).toBe("recipient cop currency");
		expect(result.expansions).toEqual([]);
	});

	test("mixed: some terms have synonyms, some don't", () => {
		const result = rewriter.rewrite("create recipient");

		// "create" has synonyms → OR group
		expect(result.expanded).toContain("(create OR ");
		// "recipient" has no synonyms → bare term
		expect(result.expanded).toContain(" recipient");
		expect(result.expanded).not.toContain("(recipient OR");
	});

	test("maxExpansionsPerTerm limits synonym count", () => {
		const limited = createQueryRewriter({ maxExpansionsPerTerm: 1 });
		const result = limited.rewrite("create user");

		// "create" synonyms: add, new, insert, make, generate, build → only 1 kept
		// Expect: "(create OR add)" — the original term + 1 synonym
		const createGroup = result.expanded.match(/\(create[^)]+\)/)?.[0] ?? "";
		const orCount = (createGroup.match(/ OR /g) ?? []).length;
		expect(orCount).toBe(1); // term OR 1-synonym

		// Same for "user": only 1 synonym
		const userGroup = result.expanded.match(/\(user[^)]+\)/)?.[0] ?? "";
		const userOrCount = (userGroup.match(/ OR /g) ?? []).length;
		expect(userOrCount).toBe(1);
	});

	test("synonym expansion can be disabled", () => {
		const noSynonyms = createQueryRewriter({ enableSynonyms: false });
		const result = noSynonyms.rewrite("create user");

		expect(result.expanded).not.toContain("OR");
		expect(result.expansions).toEqual([]);
	});
});

// ============================================================================
// File Pattern Extraction
// ============================================================================

describe("File pattern extraction", () => {
	const rewriter = createQueryRewriter();

	test("excluded terms don't trigger patterns without path syntax", () => {
		const result = rewriter.rewrite("payment service");

		// "service" is in FILE_PATTERN_EXCLUSIONS — no path syntax present
		expect(result.filePatterns).toEqual([]);
	});

	test("excluded terms DO trigger patterns with explicit path syntax", () => {
		const result = rewriter.rewrite("payment service in src/payments");

		// Query contains "/" → hasExplicitPathSyntax is true
		expect(result.filePatterns).toContain("**/service*");
	});

	test("explicit file mentions are always extracted", () => {
		const result = rewriter.rewrite("user.service.ts");

		// The regex \b[\w-]+\.(ts|tsx|...) captures "service.ts" (dots break \w match)
		// and the .ts extension triggers hasExplicitPathSyntax → service glob also included
		expect(result.filePatterns).toContain("**/service.ts");
		expect(result.filePatterns).toContain("**/service*");
	});

	test("all FILE_PATTERNS terms are excluded without path syntax", () => {
		// Every keyword in FILE_PATTERNS is also in FILE_PATTERN_EXCLUSIONS,
		// so plain-text queries should never produce glob patterns
		const keywords = [
			"service",
			"model",
			"type",
			"route",
			"controller",
			"component",
			"hook",
			"util",
			"helper",
			"config",
			"test",
			"spec",
			"middleware",
			"schema",
			"api",
		];

		for (const kw of keywords) {
			const result = rewriter.rewrite(`payment ${kw}`);
			expect(result.filePatterns).toEqual([]);
		}
	});

	test("multiple explicit files are all extracted", () => {
		const result = rewriter.rewrite(
			"check user.service.ts and auth.controller.ts",
		);

		// The file regex captures the last dotted segment: "service.ts", "controller.ts"
		// The .ts extension triggers hasExplicitPathSyntax → glob patterns also included
		expect(result.filePatterns).toContain("**/service.ts");
		expect(result.filePatterns).toContain("**/controller.ts");
		expect(result.filePatterns).toContain("**/service*");
		expect(result.filePatterns).toContain("**/controller*");
	});

	test("path extraction can be disabled", () => {
		const noPaths = createQueryRewriter({ enablePathExtraction: false });

		const result = noPaths.rewrite("user.service.ts in src/services");

		expect(result.filePatterns).toEqual([]);
	});
});

// ============================================================================
// General Behavior
// ============================================================================

describe("General rewriter behavior", () => {
	const rewriter = createQueryRewriter();

	test("original query is preserved verbatim", () => {
		const query = "create user";
		const result = rewriter.rewrite(query);

		expect(result.original).toBe(query);
	});

	test("terms are extracted correctly", () => {
		const result = rewriter.rewrite("create user profile");

		expect(result.terms).toEqual(["create", "user", "profile"]);
	});

	test("short terms (≤ 2 chars) are filtered out", () => {
		const result = rewriter.rewrite("a create b user");

		expect(result.terms).toEqual(["create", "user"]);
		expect(result.terms).not.toContain("a");
		expect(result.terms).not.toContain("b");
	});

	test("language detection works for known languages", () => {
		const result = rewriter.rewrite("typescript authentication");

		expect(result.languages).toContain("typescript");
	});

	test("language detection returns empty for unrecognized languages", () => {
		const result = rewriter.rewrite("payment recipient");

		expect(result.languages).toEqual([]);
	});
});
