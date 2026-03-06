import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { buildMcpOAuthHelperSnapshot } from "../interop/mcp-oauth-helper";
import { McpPointerCapabilityCache } from "../interop/mcp-pointer-capability-cache";
import { enforceMcpPointerAvailability } from "../interop/mcp-pointer-enforcement";
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

describe("mcp pointer runtime smoke", () => {
	test("loads pointer index and exercises lifecycle/cache/enforcement/oauth flows", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-smoke-"));
		tempRoots.push(root);

		const homeDirectory = join(root, "home");
		const directory = join(root, "project");
		const pointerDir = join(
			homeDirectory,
			".config",
			"opencode",
			".mcp-pointer",
		);
		const indexPath = join(pointerDir, "index.json");
		const checksumPath = join(pointerDir, "index.sha256");

		const pointerIndex = {
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
				invalidate_on_error_codes: [
					"auth_expired",
					"transport_unreachable",
					"capability_mismatch",
				],
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
				redact_fields: [
					"accessToken",
					"refreshToken",
					"clientSecret",
					"Authorization",
				],
				typed_error_codes: [
					"auth_missing",
					"auth_expired",
					"auth_malformed",
					"auth_transport_failure",
				],
			},
			servers: [
				{
					id: "linear",
					name: "Linear",
					source_config: join(directory, ".opencode", "opencode.json"),
					transport: "remote",
					requirement: "required",
					fingerprint_sha256: "abc",
					lifecycle_state: "idle",
					health_status: "healthy",
					capability: {
						tool_pattern: "linear_*",
						list_changed_supported: false,
						soft_ttl_ms: 300000,
						hard_ttl_ms: 1800000,
					},
					auth: {
						oauth_capable: true,
						auth_status: "not_authenticated",
						has_client_id: false,
						has_client_secret: false,
					},
				},
			],
		};

		const serialized = `${JSON.stringify(pointerIndex, null, 2)}\n`;
		await Bun.write(indexPath, serialized);
		await Bun.write(checksumPath, `${hashText(serialized)}\n`);

		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						linear: {
							type: "remote",
							url: "https://mcp.linear.app/mcp",
							oauth: {},
						},
					},
				},
				null,
				2,
			),
		);

		const resolved = await resolveMcpPointerIndex({ homeDirectory });
		expect(resolved.source).toBe("pointer");

		const lifecycle = new McpPointerLifecycleManager();
		await lifecycle.start("linear", async () => {});
		expect(lifecycle.getSnapshot("linear").state).toBe("ready");

		const cache = new McpPointerCapabilityCache<{ tools: string[] }>();
		cache.upsert({
			serverId: "linear",
			capability: { tools: ["linear_list_issues"] },
			nowMs: 1000,
			softTtlMs: 100,
			hardTtlMs: 500,
			jitterRatio: 0,
		});
		expect(cache.read("linear", 1050).state).toBe("fresh");

		const enforcement = enforceMcpPointerAvailability([
			{ serverId: "linear", requirement: "required", available: true },
		]);
		expect(enforcement.ok).toBe(true);

		const oauthSnapshot = await buildMcpOAuthHelperSnapshot({
			directory,
			homeDirectory,
		});
		expect(oauthSnapshot.pointer_source).toBe("pointer");
		expect(oauthSnapshot.servers[0]?.pointer_source).toBe("pointer");
	});
});
