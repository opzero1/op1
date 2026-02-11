/**
 * Preemptive Compaction Trigger
 *
 * Checks token usage after every tool execution and triggers
 * session summarization at 78% to avoid hitting hard limits.
 *
 * Uses Set-based loop prevention:
 * - compactionInProgress: prevents concurrent compaction for same session
 * - compactedSessions: ensures compaction only triggers once per session
 */

import type { TokenAwareClient } from "./tool-output-safety.js";

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

// ==========================================
// STATE
// ==========================================

/** Sessions currently being compacted (prevents concurrent triggers) */
const compactionInProgress = new Set<string>();

/** Sessions that have already been compacted (prevents re-trigger loops) */
const compactedSessions = new Set<string>();

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
	contextLimit = DEFAULT_CONTEXT_LIMIT,
): Promise<boolean> {
	// Skip if already compacted or in progress
	if (compactedSessions.has(sessionID)) return false;
	if (compactionInProgress.has(sessionID)) return false;

	try {
		const result = await client.session.messages({
			path: { id: sessionID },
		});

		// Runtime validate — SDK returns { data?: unknown }
		const data = result.data;
		if (!data || !Array.isArray(data) || data.length === 0) return false;

		// Calculate total token usage from assistant messages
		let totalTokens = 0;
		for (const entry of data) {
			const info = (entry as { info?: { role?: string; tokens?: { input?: number; output?: number } } }).info;
			if (info?.role === "assistant" && info.tokens) {
				totalTokens += info.tokens.input ?? 0;
				totalTokens += info.tokens.output ?? 0;
			}
		}

		// Skip if too early in the session
		if (totalTokens < MIN_TOKENS_TO_CHECK) return false;

		const usageRatio = totalTokens / contextLimit;
		if (usageRatio < PREEMPTIVE_COMPACTION_THRESHOLD) return false;

		// Trigger compaction
		compactionInProgress.add(sessionID);

		try {
			await client.session.summarize({
				path: { id: sessionID },
				query: { directory },
			});

			// Mark as compacted to prevent re-triggers
			compactedSessions.add(sessionID);
			return true;
		} finally {
			compactionInProgress.delete(sessionID);
		}
	} catch (error) {
		// Compaction failure is non-fatal — session continues normally
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`[workspace] Preemptive compaction failed for session ${sessionID}: ${message}`,
		);
		return false;
	}
}

/**
 * Reset compaction state (useful for testing).
 */
export function resetCompactionState(): void {
	compactionInProgress.clear();
	compactedSessions.clear();
}

// Re-export for configuration
export { PREEMPTIVE_COMPACTION_THRESHOLD, DEFAULT_CONTEXT_LIMIT as COMPACTION_CONTEXT_LIMIT };
