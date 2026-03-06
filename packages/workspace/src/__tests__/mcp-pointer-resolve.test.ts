import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import type { McpPointerIndex } from "../interop/mcp-pointer-contract";
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

function createValidPointerIndex(): McpPointerIndex {
	return {
		version: 1,
		generated_at: "2026-03-02T00:00:00.000Z",
		generated_by: "@op1/install",
		compatibility: { read: [1], write: 1 },
		failure_policy: {
			required: "fail_closed" as const,
			optional: "degraded" as const,
		},
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
}

async function writePointerArtifacts(
	root: string,
	indexPayload: unknown,
): Promise<void> {
	const pointerDir = join(root, ".config", "opencode", ".mcp-pointer");
	const indexPath = join(pointerDir, "index.json");
	const checksumPath = join(pointerDir, "index.sha256");
	const serialized = `${JSON.stringify(indexPayload, null, 2)}\n`;

	await Bun.write(indexPath, serialized);
	await Bun.write(checksumPath, `${hashText(serialized)}\n`);
}

describe("mcp pointer runtime resolver", () => {
	test("falls back to legacy when pointer files are missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-resolve-"));
		tempRoots.push(root);

		const resolved = await resolveMcpPointerIndex({ homeDirectory: root });
		expect(resolved.source).toBe("legacy");
		expect(resolved.issues[0]?.code).toBe("missing_pointer_index");
	});

	test("fails closed in pointer-only mode when pointer files are missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-resolve-"));
		tempRoots.push(root);

		const resolved = await resolveMcpPointerIndex({
			homeDirectory: root,
			mode: "pointer-only",
		});
		expect(resolved.source).toBe("pointer");
		expect(resolved.blocking).toBeTrue();
		expect(resolved.blockingRequired).toContain("__pointer_index__");
		expect(resolved.issues[0]?.code).toBe("missing_pointer_index");
	});

	test("loads pointer index when checksum and version are valid", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-resolve-"));
		tempRoots.push(root);

		await writePointerArtifacts(root, createValidPointerIndex());

		const resolved = await resolveMcpPointerIndex({ homeDirectory: root });
		expect(resolved.source).toBe("pointer");
		expect(resolved.index?.version).toBe(1);
	});

	test("falls back to legacy in mixed mode when required pointer server is not ready", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-resolve-"));
		tempRoots.push(root);

		const indexPayload = createValidPointerIndex();
		indexPayload.servers = [
			{
				id: "context7",
				name: "context7",
				source_config: "context7",
				transport: "remote",
				requirement: "required",
				fingerprint_sha256: "f",
				lifecycle_state: "starting",
				health_status: "healthy",
				capability: {
					tool_pattern: "*",
					list_changed_supported: false,
					soft_ttl_ms: 300000,
					hard_ttl_ms: 1800000,
				},
				auth: {
					oauth_capable: false,
					auth_status: "unknown",
					has_client_id: false,
					has_client_secret: false,
				},
			},
		];

		await writePointerArtifacts(root, indexPayload);

		const resolved = await resolveMcpPointerIndex({
			homeDirectory: root,
			mode: "mixed",
		});
		expect(resolved.source).toBe("legacy");
		expect(resolved.blocking).toBeFalse();
		expect(resolved.blockingRequired).toEqual([]);
		expect(resolved.issues.map((issue) => issue.code)).toContain(
			"pointer_required_unavailable_fallback",
		);
	});

	test("returns malformed schema issue for parseable but invalid pointer payload", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-resolve-"));
		tempRoots.push(root);

		const indexPayload = createValidPointerIndex();
		(indexPayload as { servers: unknown }).servers = {};
		await writePointerArtifacts(root, indexPayload);

		const resolved = await resolveMcpPointerIndex({ homeDirectory: root });
		expect(resolved.source).toBe("legacy");
		expect(resolved.blocking).toBeFalse();
		expect(resolved.issues[0]?.code).toBe("malformed_pointer_schema");
	});

	test("fails closed in pointer-only mode when required pointer server is not ready", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-resolve-"));
		tempRoots.push(root);

		const indexPayload = createValidPointerIndex();
		indexPayload.servers = [
			{
				id: "linear",
				name: "linear",
				source_config: "linear",
				transport: "remote",
				requirement: "required",
				fingerprint_sha256: "f",
				lifecycle_state: "starting",
				health_status: "healthy",
				capability: {
					tool_pattern: "*",
					list_changed_supported: false,
					soft_ttl_ms: 300000,
					hard_ttl_ms: 1800000,
				},
				auth: {
					oauth_capable: true,
					auth_status: "authenticated",
					has_client_id: true,
					has_client_secret: false,
				},
			},
		];

		await writePointerArtifacts(root, indexPayload);

		const resolved = await resolveMcpPointerIndex({
			homeDirectory: root,
			mode: "pointer-only",
		});
		expect(resolved.source).toBe("pointer");
		expect(resolved.blocking).toBeTrue();
		expect(resolved.blockingRequired).toContain("linear");
	});

	test("keeps pointer source in mixed mode when required server is healthy but idle", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-pointer-resolve-"));
		tempRoots.push(root);

		const indexPayload = createValidPointerIndex();
		indexPayload.servers = [
			{
				id: "context7",
				name: "context7",
				source_config: "context7",
				transport: "remote",
				requirement: "required",
				fingerprint_sha256: "f",
				lifecycle_state: "idle",
				health_status: "healthy",
				capability: {
					tool_pattern: "*",
					list_changed_supported: false,
					soft_ttl_ms: 300000,
					hard_ttl_ms: 1800000,
				},
				auth: {
					oauth_capable: true,
					auth_status: "authenticated",
					has_client_id: true,
					has_client_secret: true,
				},
			},
		];

		await writePointerArtifacts(root, indexPayload);

		const resolved = await resolveMcpPointerIndex({
			homeDirectory: root,
			mode: "mixed",
		});
		expect(resolved.source).toBe("pointer");
		expect(resolved.blocking).toBeFalse();
		expect(resolved.blockingRequired).toEqual([]);
	});
});
