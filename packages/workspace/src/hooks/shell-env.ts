/**
 * Shell Environment Hook
 *
 * Registered for the `shell.env` hook point.
 * Injects environment variables for headless/CI safety.
 *
 * Capabilities:
 * - Inject CI=true, GIT_EDITOR=:, GIT_PAGER=cat for non-interactive safety
 * - Prevent agent hangs from spawned interactive processes
 */

/**
 * Environment variables injected into ALL shell operations.
 * Prevents interactive processes (editors, pagers) from hanging the agent.
 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
	// Prevent git from opening editors (commit, rebase, merge)
	GIT_EDITOR: ":",
	EDITOR: ":",
	VISUAL: ":",
	// Prevent pagers from blocking output
	GIT_PAGER: "cat",
	PAGER: "cat",
	// Disable terminal prompts (e.g., password, credential helpers)
	GIT_TERMINAL_PROMPT: "0",
	// Signal CI environment — many tools adjust behavior
	CI: "true",
};

/**
 * Create the shell.env hook handler.
 * Injects non-interactive environment variables into all shell operations.
 */
export function createShellEnvHook(): (
	input: { cwd: string },
	output: { env: Record<string, string> },
) => Promise<void> {
	return async (_input, output) => {
		Object.assign(output.env, NON_INTERACTIVE_ENV);
	};
}
