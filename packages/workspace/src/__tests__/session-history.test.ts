import { describe, expect, test } from "bun:test";

import { redactUnknown } from "../redaction";
import {
	executeSessionInfo,
	executeSessionSearch,
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

	test("falls back to local title matching without scanning message content", async () => {
		let listCalls = 0;
		let messageCalls = 0;

		const output = await executeSessionSearch(
			{ query: "needle", limit: 1 },
			{
				projectDirectory: "/repo",
				client: {
					session: {
						list: async (input?: { search?: string }) => {
							listCalls += 1;
							if (input?.search) {
								return { data: [] };
							}
							return {
								data: [
									{
										id: "s1",
										title: "Needle refactor",
										time: { updated: 1700000000000 },
									},
								],
							};
						},
						get: async () => ({ data: null }),
						messages: async () => {
							messageCalls += 1;
							return { data: [] };
						},
					},
				},
			},
		);

		const parsed = JSON.parse(output) as {
			count: number;
			sessions: Array<{ id: string; matched_by: string }>;
		};

		expect(listCalls).toBe(2);
		expect(messageCalls).toBe(0);
		expect(parsed.count).toBe(1);
		expect(parsed.sessions).toHaveLength(1);
		expect(parsed.sessions[0]).toMatchObject({
			id: "s1",
			matched_by: "title-local",
		});
	});

	test("aggregates session info from the direct session client", async () => {
		const output = await executeSessionInfo(
			{ session_id: "s1", include_details: true },
			{
				projectDirectory: "/repo",
				client: {
					session: {
						get: async () => ({
							data: {
								id: "s1",
								title: "Main session",
								time: {
									created: 1700000000000,
									updated: 1700000100000,
								},
							},
						}),
						children: async () => ({
							data: [
								{
									id: "child-1",
									title: "Child session",
									time: { updated: 1700000200000 },
								},
							],
						}),
						todo: async () => ({
							data: [{ status: "pending" }, { status: "completed" }],
						}),
						status: async () => ({
							data: {
								s1: { mode: "running" },
							},
						}),
					},
				},
			},
		);

		const parsed = JSON.parse(output) as {
			integrity: {
				has_children: boolean;
				children_count: number;
				todo_count: number;
				pending_todo_count: number;
				status_snapshot_available: boolean;
			};
			children: Array<{ id: string }>;
			status_snapshot?: { mode?: string };
		};

		expect(parsed.integrity.has_children).toBe(true);
		expect(parsed.integrity.children_count).toBe(1);
		expect(parsed.integrity.todo_count).toBe(2);
		expect(parsed.integrity.pending_todo_count).toBe(1);
		expect(parsed.integrity.status_snapshot_available).toBe(true);
		expect(parsed.children[0]?.id).toBe("child-1");
		expect(parsed.status_snapshot?.mode).toBe("running");
	});
});
