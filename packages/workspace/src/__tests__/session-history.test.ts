import { describe, expect, test } from "bun:test";

import { redactUnknown } from "../redaction";
import {
	formatSessionListSummary,
	validateSessionArgumentsForTest,
} from "../session-history";

describe("session history helpers", () => {
	test("redacts sensitive metadata and text payloads", () => {
		const input = {
			email: "dev@example.com",
			note: "token=abc123 and api_key=xyz987",
			nested: {
				authorization: "Bearer my-secret-token",
			},
		};

		const redacted = JSON.stringify(redactUnknown(input));
		expect(redacted).not.toContain("dev@example.com");
		expect(redacted).not.toContain("abc123");
		expect(redacted).not.toContain("xyz987");
		expect(redacted).not.toContain("my-secret-token");
		expect(redacted).toContain("[REDACTED");
	});

	test("formats concise session list output", () => {
		const output = formatSessionListSummary({
			projectDirectory: "/repo",
			scopeDirectory: "/repo",
			scopeExplicit: false,
			limit: 1,
			sessions: [
				{
					id: "s1",
					title: "Auth fixes for dev@example.com",
					time: { created: 1700000000000, updated: 1700000100000 },
				},
				{
					id: "s2",
					title: "Should be trimmed by limit",
					time: { created: 1700000200000, updated: 1700000300000 },
				},
			],
			includeDetails: false,
		});

		const parsed = JSON.parse(output) as {
			count: number;
			sessions: Array<{ id: string; title: string }>;
		};

		expect(parsed.count).toBe(1);
		expect(parsed.sessions).toHaveLength(1);
		expect(parsed.sessions[0].id).toBe("s1");
		expect(parsed.sessions[0].title).toContain("[REDACTED_EMAIL]");
	});

	test("validates argument handling", () => {
		expect(() =>
			validateSessionArgumentsForTest({ query: "a", limit: 10 }),
		).toThrow("query must be at least 2 characters");

		expect(() =>
			validateSessionArgumentsForTest({ query: "valid", limit: 0 }),
		).toThrow("limit must be an integer between 1 and 50");

		expect(() => validateSessionArgumentsForTest({ directory: "   " })).toThrow(
			"directory must be a non-empty string when provided",
		);
	});
});
