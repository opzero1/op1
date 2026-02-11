/**
 * Session Compaction Hook (stub)
 *
 * Registered for the `experimental.session.compacting` hook point.
 * Phase 2 will implement plan context recovery during compaction.
 *
 * Future capabilities:
 * - Read active plan from disk on compaction
 * - Find ← CURRENT marker for resume point
 * - Inject plan + recent notepad entries into compaction context
 * - Include list of running/completed delegations
 */

/**
 * Create the experimental.session.compacting hook handler.
 * Currently a passthrough — returns undefined (no modifications to compaction).
 */
export function createCompactionHook(): (input: { sessionID: string }) => Promise<string | undefined> {
	return async (_input) => {
		// Phase 2 (Task 2.4) will implement plan context recovery here
		return undefined;
	};
}
