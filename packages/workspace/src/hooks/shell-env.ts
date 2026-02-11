/**
 * Shell Environment Hook (stub)
 *
 * Registered for the `shell.env` hook point.
 * Phase 2 will implement non-interactive environment safety here.
 *
 * Future capabilities:
 * - Inject CI=true, GIT_EDITOR=:, GIT_PAGER=cat for headless safety
 * - Auth token injection for git operations
 * - Custom env var management
 */

/**
 * Create the shell.env hook handler.
 * Currently a passthrough — returns empty env additions.
 */
export function createShellEnvHook(): (input: { directory: string }) => Record<string, string> {
	return (_input) => {
		// Phase 2 (Task 2.2) will implement non-interactive env safety here
		return {};
	};
}
