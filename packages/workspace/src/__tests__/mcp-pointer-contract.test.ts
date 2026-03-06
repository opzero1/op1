import { describe, expect, test } from "bun:test";
import {
	getReadableMcpPointerVersions,
	migratePointerIndexToCurrent,
	redactSensitiveAuthMetadata,
	resolveCompatibilitySource,
	resolveLifecycleTransition,
	shouldInvalidateOnError,
	toTypedAuthErrorCode,
} from "../interop/mcp-pointer-contract";

describe("mcp pointer contract prototype validation", () => {
	test("migrates v0 index and preserves read/write policy", () => {
		const migrated = migratePointerIndexToCurrent({
			index: {
				version: 0,
				generated_at: "2026-03-02T00:00:00.000Z",
				servers: [],
			},
		});

		expect(migrated.migrated).toBe(true);
		expect(migrated.index.compatibility.write).toBe(1);
		expect(migrated.index.compatibility.read).toEqual(
			getReadableMcpPointerVersions(1),
		);
	});

	test("uses deterministic mixed-mode precedence with fail-closed required behavior", () => {
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
				mode: "pointer-only",
				pointerAvailable: false,
				legacyAvailable: true,
				requirement: "required",
			}),
		).toEqual({ ok: false, code: "required_unavailable" });
	});

	test("validates lifecycle and security helper behavior", () => {
		expect(
			resolveLifecycleTransition({
				state: "starting",
				event: "close_requested",
			}),
		).toBe("closed");
		expect(shouldInvalidateOnError({ errorCode: "auth_expired" })).toBe(true);
		expect(toTypedAuthErrorCode({ errorCode: "bad_code" })).toBe(
			"auth_transport_failure",
		);

		const redacted = redactSensitiveAuthMetadata({
			accessToken: "token",
			Authorization: "Bearer abc",
			keep: "value",
		});
		expect(redacted.accessToken).toBe("[REDACTED]");
		expect(redacted.Authorization).toBe("[REDACTED]");
		expect(redacted.keep).toBe("value");
	});
});
