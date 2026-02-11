/**
 * Write/Edit Policy Hook
 *
 * Enforces "Delegate, Don't Implement" philosophy on the build agent
 * (orchestrator). When the orchestrator tries to use `write` or `edit`
 * tools directly, this hook warns and redirects to delegation via `task`.
 *
 * Override: pass `directEdit: true` in tool args or include `--direct`
 * in the prompt to bypass.
 */

/** Tools that write code and should be delegated */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Agent types that should delegate rather than write directly */
const ORCHESTRATOR_AGENTS = new Set(["plan", "build"]);

/**
 * Build the delegation warning message.
 */
function buildDelegationWarning(toolName: string): string {
	return `<system-reminder>
⚠️ DELEGATION POLICY

You attempted to use \`${toolName}\` directly. As the orchestrator, you should
delegate implementation to a specialist agent:

  → Use \`task\` with subagent_type="coder" for code changes
  → Use \`task\` with subagent_type="frontend" for UI changes

**Override:** If you intentionally need direct edits (e.g., config files,
small fixes), acknowledge with "direct edit:" in your reasoning.

Proceeding with the edit — but prefer delegation for production code.
</system-reminder>`;
}

/**
 * Create the write/edit policy hook.
 * Attaches to `tool.execute.before`.
 *
 * Returns a warning appended to the output (does NOT block the edit).
 * This is advisory — we trust the agent to learn the pattern.
 */
export function createWritePolicyHook() {
	return async (
		input: { tool: string; args?: unknown },
		output: { output?: string },
	): Promise<void> => {
		const toolName = input.tool.toLowerCase();
		if (!WRITE_TOOLS.has(toolName)) return;

		const args = input.args as Record<string, unknown> | undefined;

		// Check for explicit override
		if (args?.directEdit === true) return;

		// Only warn on orchestrator agents — detect via args metadata
		// The `subagent_type` or `agent_type` field indicates the caller
		const agentType = args?.agent_type as string | undefined;

		// If we can't detect agent type, skip (don't spam non-orchestrators)
		if (agentType && !ORCHESTRATOR_AGENTS.has(agentType)) return;

		// For now, only append warning to output (non-blocking)
		// This hook runs on tool.execute.after, not before
		if (typeof output.output === "string") {
			output.output = output.output + buildDelegationWarning(toolName);
		}
	};
}
