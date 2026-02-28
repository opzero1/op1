import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createContextScoutStateManager } from "../context-scout/state";
import {
	getJsonRecoveryObservabilitySnapshot,
	resetJsonRecoveryObservabilityState,
} from "../json-recovery-observability";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
	resetJsonRecoveryObservabilityState();
});

describe("createContextScoutStateManager", () => {
	test("returns empty store when index file is missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const store = await manager.readStore();

		expect(store.version).toBe(1);
		expect(Object.keys(store.patterns)).toHaveLength(0);
	});

	test("upserts and lists patterns with severity filter", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const summary = await manager.upsertPatterns([
			{
				pattern: "delegate($ARGS)",
				severity: "high",
				source_tool: "ast_grep",
				file_path: "packages/workspace/src/index.ts",
				confidence: 0.9,
				tags: ["delegation", "routing"],
			},
			{
				pattern: "console.log($MSG)",
				severity: "medium",
				source_tool: "grep",
				confidence: 0.2,
			},
		]);

		expect(summary.added).toBe(2);
		expect(summary.updated).toBe(0);

		const highOnly = await manager.listPatterns({ severity_at_least: "high" });
		expect(highOnly).toHaveLength(1);
		expect(highOnly[0]?.severity).toBe("high");
	});

	test("applies severity-aware default TTL windows", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const nowMs = Date.now();

		await manager.upsertPatterns(
			[
				{ pattern: "critical-path", severity: "critical" },
				{ pattern: "high-path", severity: "high" },
				{ pattern: "medium-path", severity: "medium" },
			],
			nowMs,
		);

		const store = await manager.readStore();
		const byPattern = new Map(
			Object.values(store.patterns).map((record) => [record.pattern, record]),
		);

		const critical = byPattern.get("critical-path");
		const high = byPattern.get("high-path");
		const medium = byPattern.get("medium-path");

		expect(critical).toBeDefined();
		expect(high).toBeDefined();
		expect(medium).toBeDefined();

		const criticalTtl = new Date(critical?.expires_at ?? "").getTime() - nowMs;
		const highTtl = new Date(high?.expires_at ?? "").getTime() - nowMs;
		const mediumTtl = new Date(medium?.expires_at ?? "").getTime() - nowMs;

		expect(criticalTtl).toBeGreaterThan(highTtl);
		expect(highTtl).toBeGreaterThan(mediumTtl);
	});

	test("dedupes and ranks patterns for injection", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const nowMs = Date.now();

		await manager.upsertPatterns(
			[
				{
					pattern: "const route = routeByCategory(task)",
					severity: "medium",
					source_tool: "grep",
					file_path: "packages/workspace/src/index.ts",
					confidence: 0.62,
					tags: ["line-extract"],
				},
				{
					pattern: "const route = routeByCategory(task)",
					severity: "high",
					source_tool: "ast_grep",
					file_path: "packages/workspace/src/index.ts",
					confidence: 0.91,
					tags: ["ast-match"],
				},
				{
					pattern: "await toolCtx.ask({ permission: 'task' })",
					severity: "critical",
					source_tool: "grep",
					file_path: "packages/workspace/src/index.ts",
					confidence: 0.6,
					tags: ["approval"],
				},
			],
			nowMs,
		);

		const ranked = await manager.listRankedPatterns({ nowMs, limit: 10 });

		expect(ranked).toHaveLength(2);
		expect(ranked[0]?.severity).toBe("critical");

		const routePattern = ranked.find((entry) =>
			entry.pattern.includes("routeByCategory"),
		);
		expect(routePattern?.severity).toBe("high");
		expect(routePattern?.confidence).toBe(0.91);
		expect(routePattern?.tags).toContain("line-extract");
		expect(routePattern?.tags).toContain("ast-match");
	});

	test("keeps ranked continuity after state rehydration", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const managerA = createContextScoutStateManager(root);
		await managerA.upsertPatterns([
			{
				pattern: "createCompactionHook(compactionDeps)",
				severity: "high",
				confidence: 0.88,
				file_path: "packages/workspace/src/index.ts",
			},
		]);

		const managerB = createContextScoutStateManager(root);
		const ranked = await managerB.listRankedPatterns({ limit: 5 });

		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.pattern).toContain("createCompactionHook");
		expect(ranked[0]?.score).toBeGreaterThan(0);
	});

	test("prunes expired patterns", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const nowMs = Date.now();
		await manager.upsertPatterns(
			[
				{
					pattern: "stale",
					severity: "medium",
					ttl_ms: 1_000,
				},
			],
			nowMs,
		);

		const removed = await manager.pruneExpired(nowMs + 2_000);
		expect(removed).toBe(1);

		const active = await manager.listPatterns({ include_expired: true });
		expect(active).toHaveLength(0);
	});

	test("recovers malformed trailing-comma JSON store", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const storePath = manager.storePath;
		await rm(join(root, "context-scout"), { recursive: true, force: true });
		await Bun.write(
			storePath,
			`{
			  "version": 1,
			  "updated_at": "2026-03-01T00:00:00.000Z",
			  "patterns": {
			    "abc": {
			      "id": "abc",
			      "pattern": "demo",
			      "severity": "high",
			      "confidence": 0.7,
			      "tags": [],
			      "first_seen_at": "2026-03-01T00:00:00.000Z",
			      "last_seen_at": "2026-03-01T00:00:00.000Z",
			      "expires_at": "2026-03-02T00:00:00.000Z",
			    },
			  },
			}`,
		);

		const store = await manager.readStore();
		expect(Object.keys(store.patterns)).toContain("abc");

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.match_total).toBe(1);
		expect(snapshot.per_method.trailing_comma_cleanup).toBe(1);
	});

	test("recovers object boundary extraction from wrapped corruption", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		await Bun.write(
			manager.storePath,
			`garbage-prefix\n{"version":1,"updated_at":"2026-03-01T00:00:00.000Z","patterns":{}}\ntrailing-garbage`,
		);

		const store = await manager.readStore();
		expect(store.version).toBe(1);

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.match_total).toBe(1);
		expect(snapshot.per_method.object_boundary_extraction).toBe(1);
	});
});
