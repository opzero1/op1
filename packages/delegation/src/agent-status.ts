import type { TaskRecord } from "./state.js";

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
	tasks: TaskRecord[],
	config?: AgentStatusConfig,
): AgentStatusEvidence {
	const nowMs = config?.nowMs ?? Date.now();
	const stuckAfterMs = config?.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
	const queueDegradedAfterMs =
		config?.queueDegradedAfterMs ?? DEFAULT_QUEUE_DEGRADED_AFTER_MS;
	const failureWindowMs = config?.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;

	const counts = {
		total: tasks.length,
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

	for (const task of tasks) {
		counts[task.status] += 1;

		if (task.status === "running") {
			const runningAgeMs =
				parseIsoAgeMs(task.started_at, nowMs) ??
				parseIsoAgeMs(task.updated_at, nowMs) ??
				parseIsoAgeMs(task.created_at, nowMs);

			if (runningAgeMs === null) {
				runningAgeUnknownCount += 1;
			} else {
				if (runningAgeMs >= stuckAfterMs) staleRunningCount += 1;
				if (oldestRunningAgeMs === null || runningAgeMs > oldestRunningAgeMs) {
					oldestRunningAgeMs = runningAgeMs;
				}
			}
		}

		if (task.status === "queued") {
			const queuedAgeMs = parseIsoAgeMs(task.created_at, nowMs);
			if (queuedAgeMs !== null && queuedAgeMs >= queueDegradedAfterMs) {
				staleQueuedCount += 1;
			}
		}

		if (task.status === "blocked") {
			const blockedAgeMs = parseIsoAgeMs(task.updated_at, nowMs);
			if (blockedAgeMs !== null && blockedAgeMs >= queueDegradedAfterMs) {
				staleBlockedCount += 1;
			}
		}

		if (task.status === "failed") {
			const failedAgeMs =
				parseIsoAgeMs(task.completed_at, nowMs) ??
				parseIsoAgeMs(task.updated_at, nowMs);
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
