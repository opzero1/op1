/**
 * Verification Enforcement Hook
 *
 * After implementer agent tasks complete, injects a verification reminder
 * to force the orchestrator to verify changes before marking tasks done.
 */

import { getGitDiffStats } from "../utils.js";

/**
 * Agents that write code and require verification after completion
 */
const IMPLEMENTER_AGENTS = ["coder", "frontend", "build"] as const;

/**
 * Build the verification reminder that gets injected after implementer tasks
 */
function buildVerificationReminder(
	agentType: string,
	fileChanges: string,
): string {
	return `
<system-reminder>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ MANDATORY VERIFICATION PROTOCOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The ${agentType} agent has completed. Subagents can make mistakes.
You MUST verify before marking this task complete.

**DO NOT TRUST MEMORY. Read the plan file NOW:**
→ Use \`plan_read\` to get the current state
→ Use \`notepad_read\` to check accumulated wisdom

**Files Changed:**
${fileChanges}

**VERIFICATION STEPS (Do these NOW):**

1. **Type Safety:** Run \`lsp_diagnostics\` on changed files
   → Must return clean (no errors)

2. **Tests:** Run project tests if they exist
   → \`bash\` with test command (bun test, npm test, etc.)

3. **Build:** Run build/typecheck if applicable
   → Must complete without errors

4. **Code Review:** \`Read\` the changed files
   → Verify changes match requirements

**IF VERIFICATION FAILS:**
- Do NOT mark task complete
- Either fix yourself or delegate again with specific fix instructions

**IF VERIFICATION PASSES:**
- Update the plan: mark task \`[x]\` via \`plan_save\`
- Record learnings via \`notepad_write\`
- Proceed to next task
</system-reminder>`;
}

/**
 * Check if a task completion is from an implementer agent and inject verification.
 * Only applies to `task` tool outputs.
 */
export async function handleVerification(
	input: { tool: string; args?: unknown },
	output: { output?: string },
	directory: string,
): Promise<void> {
	if (input.tool.toLowerCase() !== "task") return;
	if (typeof output.output !== "string") return;

	const args = input.args as { subagent_type?: string } | undefined;
	const agentType = args?.subagent_type;

	if (
		agentType &&
		IMPLEMENTER_AGENTS.includes(
			agentType as (typeof IMPLEMENTER_AGENTS)[number],
		)
	) {
		const fileChanges = await getGitDiffStats(directory);
		const reminder = buildVerificationReminder(agentType, fileChanges);
		output.output = output.output + reminder;
	}
}
