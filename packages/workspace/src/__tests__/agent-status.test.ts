import { describe, expect, test } from "bun:test";
import { summarizeAgentStatus } from "../agent-status";
import type { DelegationRecord } from "../delegation/state";

function delegation(
	status: DelegationRecord["status"],
	overrides?: Partial<DelegationRecord>,
): DelegationRecord {
	return {
		id: "d-1",
		root_session_id: "root-1",
		parent_session_id: "parent-1",
		child_session_id: "child-1",
		agent: "coder",
		prompt: "task",
		status,
		created_at: "2026-03-01T00:00:00.000Z",
		updated_at: "2026-03-01T00:00:00.000Z",
		...overrides,
	};
}

describe("agent status", () => {
	test("reports healthy when there are no delegations", () => {
		const snapshot = summarizeAgentStatus([], {
			nowMs: Date.parse("2026-03-01T00:10:00.000Z"),
		});

		expect(snapshot.status).toBe("healthy");
		expect(snapshot.counts.total).toBe(0);
	});

	test("reports healthy for fresh running delegation", () => {
		const snapshot = summarizeAgentStatus(
			[
				delegation("running", {
					started_at: "2026-03-01T00:09:30.000Z",
					updated_at: "2026-03-01T00:09:45.000Z",
				}),
			],
			{
				nowMs: Date.parse("2026-03-01T00:10:00.000Z"),
				stuckAfterMs: 120_000,
			},
		);

		expect(snapshot.status).toBe("healthy");
		expect(snapshot.indicators.stale_running_count).toBe(0);
	});

	test("reports stuck when running delegation exceeds stuck threshold", () => {
		const snapshot = summarizeAgentStatus(
			[
				delegation("running", {
					started_at: "2026-03-01T00:00:00.000Z",
				}),
			],
			{
				nowMs: Date.parse("2026-03-01T00:10:00.000Z"),
				stuckAfterMs: 60_000,
			},
		);

		expect(snapshot.status).toBe("stuck");
		expect(snapshot.indicators.stale_running_count).toBe(1);
		expect(snapshot.indicators.oldest_running_age_ms).toBeGreaterThan(60_000);
	});

	test("reports degraded when stale queued work exists", () => {
		const snapshot = summarizeAgentStatus(
			[
				delegation("queued", {
					created_at: "2026-03-01T00:00:00.000Z",
				}),
			],
			{
				nowMs: Date.parse("2026-03-01T00:10:00.000Z"),
				queueDegradedAfterMs: 60_000,
			},
		);

		expect(snapshot.status).toBe("degraded");
		expect(snapshot.indicators.stale_queued_count).toBe(1);
	});

	test("reports degraded when stale blocked work exists", () => {
		const snapshot = summarizeAgentStatus(
			[
				delegation("blocked", {
					updated_at: "2026-03-01T00:00:00.000Z",
				}),
			],
			{
				nowMs: Date.parse("2026-03-01T00:10:00.000Z"),
				queueDegradedAfterMs: 60_000,
			},
		);

		expect(snapshot.status).toBe("degraded");
		expect(snapshot.indicators.stale_blocked_count).toBe(1);
	});

	test("reports degraded when recent failures exist", () => {
		const snapshot = summarizeAgentStatus(
			[
				delegation("failed", {
					completed_at: "2026-03-01T00:09:30.000Z",
					updated_at: "2026-03-01T00:09:30.000Z",
				}),
			],
			{
				nowMs: Date.parse("2026-03-01T00:10:00.000Z"),
				failureWindowMs: 120_000,
			},
		);

		expect(snapshot.status).toBe("degraded");
		expect(snapshot.indicators.recent_failure_count).toBe(1);
	});

	test("reports degraded when running age is ambiguous", () => {
		const snapshot = summarizeAgentStatus(
			[
				delegation("running", {
					started_at: "invalid",
					updated_at: "invalid",
					created_at: "invalid",
				}),
			],
			{
				nowMs: Date.parse("2026-03-01T00:10:00.000Z"),
			},
		);

		expect(snapshot.status).toBe("degraded");
		expect(snapshot.indicators.running_age_unknown_count).toBe(1);
	});
});
