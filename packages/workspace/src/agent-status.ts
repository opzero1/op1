import type { DelegationRecord } from "./delegation/state.js";

export type AgentHealthStatus = "healthy" | "degraded" | "stuck";

export interface AgentStatusConfig {
	nowMs?: number;
	stuckAfterMs?: number;
	queueDegradedAfterMs?: number;
	failureWindowMs?: number;
}

export interface AgentStatusEvidence {
	checked_at: string;
	status: AgentHealthStatus;
	counts: {
		total: number;
		queued: number;
		blocked: number;
		running: number;
		succeeded: number;
		failed: number;
		cancelled: number;
	};
	indicators: {
		stale_running_count: number;
		oldest_running_age_ms: number | null;
		stale_queued_count: number;
		stale_blocked_count: number;
		recent_failure_count: number;
		running_age_unknown_count: number;
	};
	thresholds: {
		stuck_after_ms: number;
		queue_degraded_after_ms: number;
		failure_window_ms: number;
	};
}

const DEFAULT_STUCK_AFTER_MS = 20 * 60 * 1000;
const DEFAULT_QUEUE_DEGRADED_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 15 * 60 * 1000;

function parseIsoAgeMs(iso: string | undefined, nowMs: number): number | null {
	if (!iso) return null;
	const timestamp = Date.parse(iso);
	if (!Number.isFinite(timestamp)) return null;
	return Math.max(0, nowMs - timestamp);
}

export function summarizeAgentStatus(
	delegations: DelegationRecord[],
	config?: AgentStatusConfig,
): AgentStatusEvidence {
	const nowMs = config?.nowMs ?? Date.now();
	const stuckAfterMs = config?.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
	const queueDegradedAfterMs =
		config?.queueDegradedAfterMs ?? DEFAULT_QUEUE_DEGRADED_AFTER_MS;
	const failureWindowMs = config?.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;

	const counts = {
		total: delegations.length,
		queued: 0,
		blocked: 0,
		running: 0,
		succeeded: 0,
		failed: 0,
		cancelled: 0,
	};

	let staleRunningCount = 0;
	let staleQueuedCount = 0;
	let staleBlockedCount = 0;
	let recentFailureCount = 0;
	let runningAgeUnknownCount = 0;
	let oldestRunningAgeMs: number | null = null;

	for (const delegation of delegations) {
		counts[delegation.status] += 1;

		if (delegation.status === "running") {
			const runningAgeMs =
				parseIsoAgeMs(delegation.started_at, nowMs) ??
				parseIsoAgeMs(delegation.updated_at, nowMs) ??
				parseIsoAgeMs(delegation.created_at, nowMs);

			if (runningAgeMs === null) {
				runningAgeUnknownCount += 1;
			} else {
				if (runningAgeMs >= stuckAfterMs) staleRunningCount += 1;
				if (oldestRunningAgeMs === null || runningAgeMs > oldestRunningAgeMs) {
					oldestRunningAgeMs = runningAgeMs;
				}
			}
		}

		if (delegation.status === "queued") {
			const queuedAgeMs = parseIsoAgeMs(delegation.created_at, nowMs);
			if (queuedAgeMs !== null && queuedAgeMs >= queueDegradedAfterMs) {
				staleQueuedCount += 1;
			}
		}

		if (delegation.status === "blocked") {
			const blockedAgeMs = parseIsoAgeMs(delegation.updated_at, nowMs);
			if (blockedAgeMs !== null && blockedAgeMs >= queueDegradedAfterMs) {
				staleBlockedCount += 1;
			}
		}

		if (delegation.status === "failed") {
			const failedAgeMs =
				parseIsoAgeMs(delegation.completed_at, nowMs) ??
				parseIsoAgeMs(delegation.updated_at, nowMs);
			if (failedAgeMs !== null && failedAgeMs <= failureWindowMs) {
				recentFailureCount += 1;
			}
		}
	}

	let status: AgentHealthStatus = "healthy";

	if (staleRunningCount > 0) {
		status = "stuck";
	} else if (
		recentFailureCount > 0 ||
		staleQueuedCount > 0 ||
		staleBlockedCount > 0 ||
		runningAgeUnknownCount > 0
	) {
		status = "degraded";
	}

	return {
		checked_at: new Date(nowMs).toISOString(),
		status,
		counts,
		indicators: {
			stale_running_count: staleRunningCount,
			oldest_running_age_ms: oldestRunningAgeMs,
			stale_queued_count: staleQueuedCount,
			stale_blocked_count: staleBlockedCount,
			recent_failure_count: recentFailureCount,
			running_age_unknown_count: runningAgeUnknownCount,
		},
		thresholds: {
			stuck_after_ms: stuckAfterMs,
			queue_degraded_after_ms: queueDegradedAfterMs,
			failure_window_ms: failureWindowMs,
		},
	};
}
