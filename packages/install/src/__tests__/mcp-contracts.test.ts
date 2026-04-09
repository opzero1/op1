import { describe, expect, test } from "bun:test";
import {
	getRequiredMcpDefinitions,
	getWarmplaneDownstreamMcps,
	MCP_CATEGORIES,
	resolveMcpCriticality,
} from "../index";
import {
	computeRefreshWindow,
	getMcpPointerReadableVersions,
	isReadableMcpPointerVersion,
	MCP_POINTER_LIFECYCLE_POLICY,
	migratePointerIndexToCurrent,
	redactSensitiveAuthMetadata,
	resolveCompatibilitySource,
	resolveLifecycleTransition,
	shouldInvalidateOnError,
	toTypedAuthErrorCode,
} from "../mcp-pointer-contract";

describe("MCP requirement contract", () => {
	test("includes required MCPs by default from category contract", () => {
		const required = getRequiredMcpDefinitions(MCP_CATEGORIES);
		const requiredIds = new Set(required.map((entry) => entry.id));

		expect(requiredIds.has("context7")).toBe(true);
		expect(requiredIds.has("grep_app")).toBe(true);
	});

	test("uses MCP-level required override over category defaults", () => {
		const category = {
			id: "test",
			name: "Test",
			description: "test",
			requiredByDefault: true,
			mcps: [],
		};

		expect(
			resolveMcpCriticality(category, {
				id: "override-required",
				name: "Override required",
				description: "",
				config: { type: "remote", url: "https://example.com" },
				toolPattern: "test_*",
				agentAccess: ["researcher"],
				required: false,
			}),
		).toBe("optional");
	});

	test("includes shadcn in the design MCP catalog", () => {
		const design = MCP_CATEGORIES.find((category) => category.id === "design");
		const shadcn = design?.mcps.find((mcp) => mcp.id === "shadcn");

		expect(shadcn?.name).toBe("shadcn/ui");
		expect(shadcn?.toolPattern).toBe("shadcn_*");
		expect(shadcn?.agentAccess).toEqual(["researcher", "coder", "frontend"]);
		expect(shadcn?.config).toEqual({
			type: "local",
			command: ["npx", "-y", "shadcn@latest", "mcp"],
		});
	});

	test("includes ui.sh in the design MCP catalog", () => {
		const design = MCP_CATEGORIES.find((category) => category.id === "design");
		const uidotsh = design?.mcps.find((mcp) => mcp.id === "uidotsh");

		expect(uidotsh?.name).toBe("ui.sh");
		expect(uidotsh?.toolPattern).toBe("uidotsh_*");
		expect(uidotsh?.agentAccess).toEqual([
			"build",
			"researcher",
			"coder",
			"frontend",
		]);
		expect(uidotsh?.config).toEqual({
			type: "remote",
			url: "https://ui.sh/mcp?agent=opencode",
			headers: {
				Authorization: "Bearer {env:UIDOTSH_TOKEN}",
			},
		});
	});

	test("grants build agent access to the mcp0 facade", () => {
		const facade = MCP_CATEGORIES.find((category) => category.id === "mcp0");
		const mcp0 = facade?.mcps.find((mcp) => mcp.id === "mcp0");

		expect(mcp0?.agentAccess).toEqual([
			"build",
			"researcher",
			"coder",
			"frontend",
		]);
	});

	test("treats non-mcp0 selections as warmplane downstream servers", () => {
		const context7 = MCP_CATEGORIES.find(
			(category) => category.id === "utilities",
		)?.mcps.find((mcp) => mcp.id === "context7");
		const figma = MCP_CATEGORIES.find(
			(category) => category.id === "design",
		)?.mcps.find((mcp) => mcp.id === "figma");
		const facade = MCP_CATEGORIES.find((category) => category.id === "mcp0")
			?.mcps[0];

		if (!facade || !context7 || !figma) {
			throw new Error("Expected mcp0, context7, and figma MCP definitions");
		}

		expect(
			getWarmplaneDownstreamMcps([facade, context7, figma]).map(
				(mcp) => mcp.id,
			),
		).toEqual(["context7", "figma"]);
	});
});

describe("MCP pointer compatibility contract", () => {
	test("supports read N/N-1 and write N version policy", () => {
		expect(getMcpPointerReadableVersions(1)).toEqual([1]);
		expect(getMcpPointerReadableVersions(3)).toEqual([3, 2]);

		expect(
			isReadableMcpPointerVersion({
				version: 3,
				readableVersions: getMcpPointerReadableVersions(3),
			}),
		).toBe(true);

		expect(
			isReadableMcpPointerVersion({
				version: 1,
				readableVersions: getMcpPointerReadableVersions(3),
			}),
		).toBe(false);
	});

	test("defines lifecycle transition table with close-during-start semantics", () => {
		expect(MCP_POINTER_LIFECYCLE_POLICY.concurrency.start_request_dedupe).toBe(
			"singleflight",
		);
		expect(MCP_POINTER_LIFECYCLE_POLICY.concurrency.close_during_start).toBe(
			"mark_closing_then_close_after_start_settles",
		);

		expect(
			resolveLifecycleTransition({
				state: "starting",
				event: "close_requested",
			}),
		).toBe("closed");

		expect(
			resolveLifecycleTransition({
				state: "ready",
				event: "start_succeeded",
			}),
		).toBeNull();
	});

	test("defines staleness policy with TTL jitter and error invalidation", () => {
		const window = computeRefreshWindow({ nowMs: 1000 });
		expect(window.refresh_at_ms).toBeGreaterThan(1000);
		expect(window.expires_at_ms).toBeGreaterThan(window.refresh_at_ms);

		expect(shouldInvalidateOnError({ errorCode: "auth_expired" })).toBe(true);
		expect(shouldInvalidateOnError({ errorCode: "rate_limited" })).toBe(false);
	});

	test("defines compatibility matrix precedence and fail policy", () => {
		expect(
			resolveCompatibilitySource({
				mode: "mixed",
				pointerAvailable: true,
				legacyAvailable: true,
				requirement: "optional",
			}),
		).toEqual({ ok: true, source: "pointer" });

		expect(
			resolveCompatibilitySource({
				mode: "mixed",
				pointerAvailable: false,
				legacyAvailable: true,
				requirement: "optional",
			}),
		).toEqual({ ok: true, source: "legacy" });

		expect(
			resolveCompatibilitySource({
				mode: "pointer-only",
				pointerAvailable: false,
				legacyAvailable: true,
				requirement: "required",
			}),
		).toEqual({ ok: false, code: "required_unavailable" });
	});

	test("migrates readable N-1 indexes to current write version", () => {
		const migrated = migratePointerIndexToCurrent({
			index: {
				version: 0,
				generated_at: "2026-03-02T00:00:00.000Z",
				servers: [],
			},
		});

		expect(migrated.migrated).toBe(true);
		expect(migrated.from_version).toBe(0);
		expect(migrated.index.version).toBe(1);
		expect(migrated.index.compatibility.write).toBe(1);
		expect(migrated.index.compatibility.read).toEqual([1]);
	});

	test("enforces auth security redaction and typed error mapping", () => {
		const redacted = redactSensitiveAuthMetadata({
			accessToken: "secret",
			clientSecret: "super-secret",
			region: "us",
		});

		expect(redacted.accessToken).toBe("[REDACTED]");
		expect(redacted.clientSecret).toBe("[REDACTED]");
		expect(redacted.region).toBe("us");

		expect(toTypedAuthErrorCode({ errorCode: "auth_expired" })).toBe(
			"auth_expired",
		);
		expect(toTypedAuthErrorCode({ errorCode: "unknown_code" })).toBe(
			"auth_transport_failure",
		);
	});
});
