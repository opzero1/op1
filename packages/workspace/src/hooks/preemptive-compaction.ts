/**
 * Preemptive Compaction Trigger
 *
 * Checks token usage after every tool execution and triggers
 * session summarization at 78% to avoid hitting hard limits.
 *
 * Uses in-memory guards:
 * - compactionInProgress: prevents concurrent compaction for same session
 * - lastCompactionAt: cooldown window to avoid tight summarize loops
 */

import { createLogger } from "../logging.js";
import type { TokenAwareClient } from "./tool-output-safety.js";

const logger = createLogger("workspace");

// ==========================================
// CONSTANTS
// ==========================================

/**
 * Trigger compaction when token usage exceeds this ratio.
 * 78% gives enough headroom for the compaction process itself.
 */
const PREEMPTIVE_COMPACTION_THRESHOLD = 0.78;

/**
 * Default context window limit (tokens).
 * Conservative — most models support 200k+.
 */
const DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * Minimum tokens used before we bother checking.
 * Avoids overhead on early-session tool calls.
 */
const MIN_TOKENS_TO_CHECK = 20_000;

// ==========================================
// TYPES
// ==========================================

/**
 * Extended client interface for compaction trigger.
 * Needs session.summarize in addition to session.messages.
 *
 * summarize body is optional in the SDK — providerID/modelID
 * are filled server-side when omitted.
 */
export interface CompactionClient extends TokenAwareClient {
	session: TokenAwareClient["session"] & {
		summarize: (opts: {
			path: { id: string };
			body?: { providerID: string; modelID: string };
			query?: { directory?: string };
		}) => Promise<unknown>;
	};
}

interface PreemptiveCompactionOptions {
	contextLimit?: number;
	thresholdRatio?: number;
}

// ==========================================
// STATE
// ==========================================

/** Sessions currently being compacted (prevents concurrent triggers) */
const compactionInProgress = new Set<string>();

/** Last successful compaction timestamp per session */
const lastCompactionAt = new Map<string, number>();

/** Cooldown between compactions for the same session */
const COMPACTION_COOLDOWN_MS = 60_000;

// ==========================================
// IMPLEMENTATION
// ==========================================

/**
 * Check if preemptive compaction should be triggered for this session.
 * Returns true if compaction was triggered.
 */
export async function checkPreemptiveCompaction(
	client: CompactionClient,
	sessionID: string,
	directory: string,
	options?: PreemptiveCompactionOptions,
): Promise<boolean> {
	const contextLimit = options?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
	const thresholdRatio =
		typeof options?.thresholdRatio === "number"
			? Math.min(0.98, Math.max(0.1, options.thresholdRatio))
			: PREEMPTIVE_COMPACTION_THRESHOLD;

	// Skip if compaction already running
	if (compactionInProgress.has(sessionID)) return false;

	// Skip if a recent compaction already happened
	const last = lastCompactionAt.get(sessionID);
	if (last && Date.now() - last < COMPACTION_COOLDOWN_MS) return false;

	compactionInProgress.add(sessionID);

	try {
		const result = await client.session.messages({
			path: { id: sessionID },
		});

		// Runtime validate — SDK returns { data?: unknown }
		const data = result.data;
		if (!data || !Array.isArray(data) || data.length === 0) return false;

		// Estimate current context occupancy from the latest assistant turn.
		// input tokens are a close proxy for current context-window usage.
		const assistantMessages = data.filter((entry) => {
			const info = (entry as { info?: { role?: string } }).info;
			return info?.role === "assistant";
		});

		if (assistantMessages.length === 0) return false;

		const latestAssistant = assistantMessages[assistantMessages.length - 1] as {
			info?: { tokens?: { input?: number; output?: number } };
		};

		const totalTokens =
			(latestAssistant.info?.tokens?.input ?? 0) +
			(latestAssistant.info?.tokens?.output ?? 0);

		// Skip if too early in the session
		if (totalTokens < MIN_TOKENS_TO_CHECK) return false;

		const usageRatio = totalTokens / contextLimit;
		if (usageRatio < thresholdRatio) return false;

		await client.session.summarize({
			path: { id: sessionID },
			query: { directory },
		});

		lastCompactionAt.set(sessionID, Date.now());
		return true;
	} catch (error) {
		// Compaction failure is non-fatal — session continues normally
		const message = error instanceof Error ? error.message : String(error);
		logger.error(
			`[workspace] Preemptive compaction failed for session ${sessionID}: ${message}`,
		);
		return false;
	} finally {
		compactionInProgress.delete(sessionID);
	}
}

export async function runManualCompaction(
	client: CompactionClient,
	sessionID: string,
	directory: string,
): Promise<{ compacted: boolean; message: string }> {
	if (compactionInProgress.has(sessionID)) {
		return {
			compacted: false,
			message: "Compaction is already in progress for this session.",
		};
	}

	compactionInProgress.add(sessionID);

	try {
		await client.session.summarize({
			path: { id: sessionID },
			query: { directory },
		});

		lastCompactionAt.set(sessionID, Date.now());
		return {
			compacted: true,
			message: "Session compaction completed.",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(
			`[workspace] Manual compaction failed for session ${sessionID}: ${message}`,
		);
		return {
			compacted: false,
			message: `Manual compaction failed: ${message}`,
		};
	} finally {
		compactionInProgress.delete(sessionID);
	}
}

/**
 * Mark session context as changed (plan/todo/notepad updates).
 * This clears cooldown so compaction can run again immediately if needed.
 */
export function markCompactionStateDirty(sessionID: string): void {
	lastCompactionAt.delete(sessionID);
}

/**
 * Reset compaction state (useful for testing).
 */
export function resetCompactionState(): void {
	compactionInProgress.clear();
	lastCompactionAt.clear();
}

// Re-export for configuration
export {
	PREEMPTIVE_COMPACTION_THRESHOLD,
	DEFAULT_CONTEXT_LIMIT as COMPACTION_CONTEXT_LIMIT,
};
