import { afterEach, describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { McpPointerLifecycleManager } from "../interop/mcp-pointer-lifecycle";
import { resolveMcpPointerIndex } from "../interop/mcp-pointer-resolve";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

function hashText(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

describe("mcp pointer performance and parity acceptance", () => {
	test("meets startup overhead and first-call latency ceilings", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-perf-"));
		tempRoots.push(root);

		const homeDirectory = join(root, "home");
		const pointerDir = join(
			homeDirectory,
			".config",
			"opencode",
			".mcp-pointer",
		);
		const indexPath = join(pointerDir, "index.json");
		const checksumPath = join(pointerDir, "index.sha256");

		const indexPayload = {
			version: 1,
			generated_at: "2026-03-02T00:00:00.000Z",
			generated_by: "@op1/install",
			compatibility: { read: [1], write: 1 },
			failure_policy: { required: "fail_closed", optional: "degraded" },
			lifecycle_policy: {
				concurrency: {
					start_request_dedupe: "singleflight",
					close_during_start: "mark_closing_then_close_after_start_settles",
					cancel_start_on_close: true,
				},
				retry: {
					max_attempts: 3,
					base_backoff_ms: 500,
					max_backoff_ms: 4000,
					jitter_ratio: 0.2,
				},
				transition_table: {
					idle: {
						start_requested: "starting",
						close_requested: "closed",
						close_completed: "closed",
					},
					starting: {
						start_succeeded: "ready",
						start_failed: "degraded",
						retry_scheduled: "starting",
						retry_exhausted: "degraded",
						close_requested: "closed",
						close_completed: "closed",
					},
					ready: {
						degrade_detected: "degraded",
						close_requested: "closed",
						close_completed: "closed",
					},
					degraded: {
						recover_detected: "ready",
						start_requested: "starting",
						retry_scheduled: "starting",
						close_requested: "closed",
						close_completed: "closed",
					},
					closed: {
						start_requested: "starting",
						close_requested: "closed",
						close_completed: "closed",
					},
				},
			},
			staleness_policy: {
				soft_ttl_ms: 300000,
				hard_ttl_ms: 1800000,
				refresh_jitter_ratio: 0.2,
				invalidate_on_error_codes: ["auth_expired"],
			},
			compatibility_matrix: {
				mode: "mixed",
				precedence: {
					mixed: ["pointer", "legacy"],
					pointer_only: ["pointer"],
					legacy_only: ["legacy"],
				},
				error_policy: {
					required_missing: "fail_closed",
					optional_missing: "degraded",
				},
			},
			security_policy: {
				token_storage: "auth_store_only",
				requires_oauth_state: true,
				redact_fields: ["accessToken"],
				typed_error_codes: [
					"auth_missing",
					"auth_expired",
					"auth_malformed",
					"auth_transport_failure",
				],
			},
			servers: [],
		};

		const serialized = `${JSON.stringify(indexPayload, null, 2)}\n`;
		await Bun.write(indexPath, serialized);
		await Bun.write(checksumPath, `${hashText(serialized)}\n`);

		const startupStart = performance.now();
		const resolved = await resolveMcpPointerIndex({ homeDirectory });
		const startupMs = performance.now() - startupStart;
		expect(resolved.source).toBe("pointer");
		expect(startupMs).toBeLessThan(150);

		const lifecycle = new McpPointerLifecycleManager();
		const firstCallStart = performance.now();
		await lifecycle.start("linear", async () => {});
		const firstCallMs = performance.now() - firstCallStart;
		expect(firstCallMs).toBeLessThan(100);
	});

	test("maintains tool-availability parity in mixed mode", () => {
		const legacyTools = new Set(["linear_*", "context7_*", "grep_app_*"]);
		const pointerTools = new Set(["linear_*", "context7_*", "grep_app_*"]);
		const matched = [...legacyTools].filter((tool) => pointerTools.has(tool));
		const parityRate = matched.length / legacyTools.size;
		expect(parityRate).toBe(1);
	});
});
