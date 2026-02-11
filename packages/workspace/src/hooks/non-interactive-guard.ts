/**
 * Non-Interactive Command Guard
 *
 * Intercepts `bash` tool calls via `tool.execute.before` to detect
 * and warn about interactive commands that would hang the agent.
 */

/**
 * Commands that require interactive TTY input and will hang the agent.
 * Matched against the full command string.
 */
const BANNED_COMMAND_PATTERNS = [
	// Editors
	/\bvim?\b/,
	/\bnvim\b/,
	/\bnano\b/,
	/\bemacs\b(?!\s+--batch)/,
	// Pagers
	/\bless\b/,
	/\bmore\b/,
	// Interactive git operations
	/\bgit\s+add\s+(-p|--patch|-i|--interactive)\b/,
	/\bgit\s+rebase\s+-i\b/,
	/\bgit\s+rebase\s+--interactive\b/,
	/\bgit\s+stash\s+(push\s+)?-p\b/,
	/\bgit\s+checkout\s+-p\b/,
	// Interactive programs
	/\btop\b/,
	/\bhtop\b/,
	/\birb\b/,
	/\bpython3?\s*$/,
	/\bnode\s*$/,
] as const;

const INTERACTIVE_COMMAND_WARNING = `⚠️ BLOCKED: This command requires interactive input and will hang.

The agent cannot interact with TTY-based programs (editors, pagers, interactive git).

**Alternatives:**
- Instead of \`vim/nano\`: use the Edit or Write tool
- Instead of \`less/more\`: pipe output directly (output is already captured)
- Instead of \`git add -p\`: use \`git add <specific-files>\`
- Instead of \`git rebase -i\`: use \`git rebase <branch>\` (non-interactive)
- Instead of \`python\`/\`node\` REPL: use \`python -c "..."\` or \`node -e "..."\``;

/**
 * Check if a bash command would require interactive input.
 * Returns the warning message if blocked, undefined if safe.
 */
export function checkInteractiveCommand(command: string): string | undefined {
	if (typeof command !== "string") return undefined;

	const trimmed = command.trim();
	if (!trimmed) return undefined;

	for (const pattern of BANNED_COMMAND_PATTERNS) {
		if (pattern.test(trimmed)) {
			return INTERACTIVE_COMMAND_WARNING;
		}
	}

	return undefined;
}

/**
 * Create the tool.execute.before hook handler.
 * Detects interactive commands in bash tool calls and warns the agent.
 */
export function createToolExecuteBeforeHook(): (
	input: { tool: string; sessionID: string; callID: string },
	output: { args: Record<string, unknown> },
) => Promise<void> {
	return async (input, output) => {
		// Only intercept bash tool
		if (input.tool.toLowerCase() !== "bash") return;

		const command = output.args?.command;
		if (typeof command !== "string") return;

		const warning = checkInteractiveCommand(command);
		if (warning) {
			// Replace the command with an echo of the warning
			// This prevents the interactive command from running
			output.args.command = `echo "${warning.replace(/"/g, '\\"')}"`;
		}
	};
}
