import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat.js";
import { createContextScoutStateManager } from "../context-scout/state.js";
import { createContextScoutHook } from "../hooks/context-scout.js";

const tempRoots: string[] = [];

function estimateTokenCount(value: string): number {
	return Math.max(1, Math.ceil(value.length / 4));
}

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("context scout hook", () => {
	test("extracts from search output and injects ranked hints into planning tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);
		const routerPath = join(root, "packages", "workspace", "src", "router.ts");

		const manager = createContextScoutStateManager(root);
		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			workspaceRoot: root,
			allowlistedRoots: [root],
		});

		await hook(
			{ tool: "grep", sessionID: "session-a", callID: "call-1" },
			{
				title: "grep",
				output: [
					`${routerPath}:`,
					"  Line 12: const route = routeByCategory(task);",
					"  Line 18: const route = routeByCategory(task);",
				].join("\n"),
				metadata: {},
			},
		);

		const ranked = await manager.listRankedPatterns({ limit: 10 });
		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.pattern).toContain("routeByCategory");

		const output = {
			title: "plan",
			output: "# Implementation Plan",
			metadata: {},
		};

		await hook(
			{ tool: "plan_read", sessionID: "session-a", callID: "call-2" },
			output,
		);

		expect(output.output).toContain("[context-scout]");
		expect(output.output).toContain("routeByCategory");
	});

	test("enforces privacy filters and token-budget limits before injection", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		await manager.upsertPatterns([
			{
				pattern: "const api_key = sk-live-secret-token-1234567890",
				severity: "critical",
				confidence: 0.95,
				file_path: "packages/workspace/src/secrets.ts",
			},
			{
				pattern: "DATABASE_URL=postgres://local",
				severity: "high",
				confidence: 0.82,
				file_path: ".env.production",
			},
			{
				pattern: "createSafeRuntimeHook(name, factory, config)",
				severity: "high",
				confidence: 0.91,
				file_path: "packages/workspace/src/hooks/safe-hook.ts",
				tags: ["hook", "runtime"],
			},
			{
				pattern: "createDelegationStateManager(workspaceDir)",
				severity: "medium",
				confidence: 0.79,
				file_path: "packages/workspace/src/index.ts",
			},
		]);

		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			maxInjectionTokens: 120,
			maxInjectionPatterns: 3,
		});

		const output = {
			title: "plan",
			output: "# Active Plan",
			metadata: {},
		};

		await hook(
			{ tool: "plan_read", sessionID: "session-b", callID: "call-1" },
			output,
		);

		expect(output.output).toContain("[context-scout]");
		expect(output.output).toContain("createSafeRuntimeHook");
		expect(output.output).not.toContain("sk-live-secret-token-1234567890");
		expect(output.output).not.toContain(".env.production");
	});

	test("prunes expired records and keeps injection as no-op when nothing eligible", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		let nowMs = Date.now();

		await manager.upsertPatterns(
			[
				{
					pattern: "stale-pattern",
					severity: "high",
					confidence: 0.9,
					ttl_ms: 1_000,
				},
			],
			nowMs,
		);

		nowMs += 5_000;

		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			now: () => nowMs,
		});

		const output = {
			title: "plan",
			output: "# Active Plan",
			metadata: {},
		};

		await hook(
			{ tool: "plan_read", sessionID: "session-c", callID: "call-1" },
			output,
		);

		expect(output.output).toBe("# Active Plan");

		const remaining = await manager.listPatterns({ nowMs });
		expect(remaining).toHaveLength(0);
	});

	test("enforces allowlisted roots for extracted file paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const allowlistedRoot = join(root, "repo");
		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			workspaceRoot: root,
			allowlistedRoots: [allowlistedRoot],
		});

		await hook(
			{ tool: "grep", sessionID: "session-d", callID: "call-1" },
			{
				title: "grep",
				output: [
					`${allowlistedRoot}/safe.ts:`,
					"  Line 2: const safePattern = createSafeRuntimeHook();",
					"/tmp/blocked.ts:",
					"  Line 9: const blockedPattern = hardcodedSecretToken;",
				].join("\n"),
				metadata: {},
			},
		);

		const ranked = await manager.listRankedPatterns({ limit: 5 });
		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.file_path).toContain(`${allowlistedRoot}/safe.ts`);
		expect(ranked[0]?.pattern).toContain("createSafeRuntimeHook");
	});

	test("rejects windows-style traversal paths outside allowlisted roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const allowlistedRoot = join(root, "repo");
		const safePath = join(allowlistedRoot, "safe.ts");
		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			workspaceRoot: root,
			allowlistedRoots: [allowlistedRoot],
		});

		await hook(
			{ tool: "glob", sessionID: "session-win", callID: "call-1" },
			{
				title: "glob",
				output: [safePath, "..\\blocked.ts/sneak.ts"].join("\n"),
				metadata: {},
			},
		);

		const ranked = await manager.listRankedPatterns({ limit: 5 });
		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.file_path).toContain(safePath);
		expect(ranked[0]?.pattern).toContain("safe.ts");
	});

	test("accepts Windows absolute drive and UNC grep headers when allowlisted", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			workspaceRoot: "C:\\repo",
			allowlistedRoots: ["C:\\repo", "\\\\server\\share\\repo"],
		});

		await hook(
			{ tool: "grep", sessionID: "session-win-abs", callID: "call-1" },
			{
				title: "grep",
				output: [
					"C:\\repo\\src\\router.ts:",
					"  Line 12: const route = routeByCategory(task);",
					"\\\\server\\share\\repo\\hooks\\guard.ts:",
					"  Line 4: const guard = createSafeRuntimeHook();",
				].join("\n"),
				metadata: {},
			},
		);

		const ranked = await manager.listRankedPatterns({ limit: 10 });
		expect(ranked).toHaveLength(2);
		expect(
			ranked.some((entry) => entry.file_path === "C:/repo/src/router.ts"),
		).toBe(true);
		expect(
			ranked.some(
				(entry) => entry.file_path === "//server/share/repo/hooks/guard.ts",
			),
		).toBe(true);
	});

	test("rejects path-based candidates when file path is missing or stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		const allowlistedRoot = join(root, "repo");
		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			workspaceRoot: root,
			allowlistedRoots: [allowlistedRoot],
		});

		await hook(
			{ tool: "grep", sessionID: "session-path-trust", callID: "call-1" },
			{
				title: "grep",
				output: [
					`${allowlistedRoot}/safe.ts:`,
					"  Line 2: const safePattern = createSafeRuntimeHook();",
					"(results truncated)",
					"  Line 9: const stalePattern = shouldNotIngestWithoutHeader;",
				].join("\n"),
				metadata: {},
			},
		);

		await hook(
			{
				tool: "lsp_symbols",
				sessionID: "session-path-trust",
				callID: "call-2",
			},
			{
				title: "lsp",
				output: JSON.stringify([{ name: "orphanSymbolWithoutPath" }]),
				metadata: {},
			},
		);

		const ranked = await manager.listRankedPatterns({ limit: 10 });
		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.pattern).toContain("createSafeRuntimeHook");
		expect(ranked[0]?.pattern).not.toContain("stalePattern");
		expect(
			ranked.some((entry) => entry.pattern.includes("orphanSymbolWithoutPath")),
		).toBe(false);
	});

	test("refreshes stale pattern after expiration when new extraction arrives", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		let nowMs = Date.now();
		const filePath = join(root, "repo", "router.ts");

		await manager.upsertPatterns(
			[
				{
					pattern: "const route = routeByCategory(task)",
					severity: "high",
					source_tool: "grep",
					file_path: filePath,
					confidence: 0.9,
					ttl_ms: 1_000,
				},
			],
			nowMs,
		);

		nowMs += 5_000;

		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			workspaceRoot: root,
			allowlistedRoots: [root],
			now: () => nowMs,
		});

		await hook(
			{ tool: "grep", sessionID: "session-e", callID: "call-1" },
			{
				title: "grep",
				output: [
					`${filePath}:`,
					"  Line 12: const route = routeByCategory(task)",
				].join("\n"),
				metadata: {},
			},
		);

		const active = await manager.listPatterns({ nowMs });
		expect(active).toHaveLength(1);
		expect(active[0]?.last_seen_at).toBe(new Date(nowMs).toISOString());
	});

	test("keeps injected block within configured token budget", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		await manager.upsertPatterns(
			Array.from({ length: 24 }, (_, index) => ({
				pattern: `const pattern_${index} = routeByCategory(task_${index})`,
				severity: "high" as const,
				confidence: 0.92,
				file_path: `packages/workspace/src/file-${index}.ts`,
			})),
		);

		const maxTokens = 110;
		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			maxInjectionTokens: maxTokens,
			maxInjectionPatterns: 12,
		});

		const output = {
			title: "plan",
			output: "# Active Plan",
			metadata: {},
		};

		await hook(
			{ tool: "plan_read", sessionID: "session-f", callID: "call-1" },
			output,
		);

		expect(output.output).toContain("[context-scout]");
		const markerIndex = output.output.indexOf("<system-reminder>");
		expect(markerIndex).toBeGreaterThan(-1);
		const injectedBlock = output.output.slice(markerIndex);
		expect(estimateTokenCount(injectedBlock)).toBeLessThanOrEqual(maxTokens);
	});

	test("recovers from corrupted store during extraction and continues ingestion", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-context-scout-hook-test-"));
		tempRoots.push(root);

		const manager = createContextScoutStateManager(root);
		await Bun.write(manager.storePath, "not valid json");

		const hook = createContextScoutHook({
			enabled: true,
			stateManager: manager,
			workspaceRoot: root,
			allowlistedRoots: [root],
		});

		await hook(
			{ tool: "grep", sessionID: "session-g", callID: "call-1" },
			{
				title: "grep",
				output: [
					`${join(root, "packages", "workspace", "src", "index.ts")}:`,
					"  Line 99: const safe = createSafeRuntimeHook(name, factory, config)",
				].join("\n"),
				metadata: {},
			},
		);

		const active = await manager.listRankedPatterns({ limit: 5 });
		expect(active).toHaveLength(1);
		expect(active[0]?.pattern).toContain("createSafeRuntimeHook");
	});
});
