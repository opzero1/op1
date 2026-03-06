import { describe, expect, test } from "bun:test";
import { McpPointerTelemetry } from "../interop/mcp-pointer-telemetry";

describe("mcp pointer telemetry", () => {
	test("tracks pointer counters and derived rates", () => {
		const telemetry = new McpPointerTelemetry();
		telemetry.recordPointerHit();
		telemetry.recordPointerHit({ stale: true });
		telemetry.recordForcedRefresh();
		telemetry.recordFallbackEvent();
		telemetry.recordMismatchEvent();

		const snapshot = telemetry.snapshot();
		expect(snapshot.pointer_hit).toBe(2);
		expect(snapshot.stale_hit).toBe(1);
		expect(snapshot.forced_refresh).toBe(1);
		expect(snapshot.fallback_events).toBe(1);
		expect(snapshot.mismatch_events).toBe(1);
		expect(snapshot.fallback_rate).toBe(0.5);
		expect(snapshot.mismatch_rate).toBe(0.5);
	});
});
