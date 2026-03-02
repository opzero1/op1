/**
 * Rules Injector Lite
 *
 * Lightweight, scoped, idempotent rule injection for tool outputs.
 * Rules are injected once per session and phase, then cached.
 */

interface RuleDefinition {
	id: string;
	content: string;
	tools: string[];
	phases: string[];
}

interface RulesInjectorLiteDeps {
	getCurrentPhase: () => Promise<string | null>;
}

interface ToolExecuteAfterInput {
	tool: string;
	sessionID: string;
	callID: string;
	args?: unknown;
}

interface ToolExecuteAfterOutput {
	title: string;
	output: string;
	metadata: unknown;
}

const RULES: RuleDefinition[] = [
	{
		id: "read-before-write",
		phases: ["2", "3", "4", "5"],
		tools: ["edit", "write"],
		content:
			"Read-before-write is mandatory for existing files. Read the target file in the same session before any edit/write attempt.",
	},
	{
		id: "hashline-structural-boundaries",
		phases: ["2"],
		tools: ["edit"],
		content:
			"Use parser-safe structural boundaries for markdown/code-fence/frontmatter edits. Avoid section-spanning replacements when structural anchors are present.",
	},
	{
		id: "json-compatibility-check",
		phases: ["2"],
		tools: ["read", "edit", "write"],
		content:
			"When touching JSON files, preserve strict JSON validity and avoid introducing syntax that could break parse-recovery compatibility paths.",
	},
];

const sessionAppliedRules = new Map<string, Set<string>>();

function getSessionAppliedRules(sessionID: string): Set<string> {
	const existing = sessionAppliedRules.get(sessionID);
	if (existing) return existing;
	const created = new Set<string>();
	sessionAppliedRules.set(sessionID, created);
	return created;
}

function createRuleKey(ruleID: string, phase: string | null): string {
	return `${phase || "unknown"}:${ruleID}`;
}

function normalizeToolName(toolName: string): string {
	return toolName.toLowerCase();
}

function ruleAppliesToPhase(
	rule: RuleDefinition,
	phase: string | null,
): boolean {
	if (!phase) return false;
	return rule.phases.includes(phase);
}

function ruleAppliesToTool(rule: RuleDefinition, toolName: string): boolean {
	return rule.tools.includes(toolName);
}

function formatRuleInjection(
	rule: RuleDefinition,
	phase: string | null,
): string {
	return `\n\n<system-reminder>\n[rule:${rule.id}:phase-${phase || "unknown"}]\n${rule.content}\n</system-reminder>`;
}

export function createRulesInjectorLiteHook(
	deps: RulesInjectorLiteDeps,
): (
	input: ToolExecuteAfterInput,
	output: ToolExecuteAfterOutput,
) => Promise<void> {
	return async (input, output) => {
		if (typeof output.output !== "string") return;

		const toolName = normalizeToolName(input.tool);
		const phase = await deps.getCurrentPhase();
		if (!phase) return;

		const applied = getSessionAppliedRules(input.sessionID);
		const injectables = RULES.filter((rule) => ruleAppliesToPhase(rule, phase))
			.filter((rule) => ruleAppliesToTool(rule, toolName))
			.filter((rule) => !applied.has(createRuleKey(rule.id, phase)));

		if (injectables.length === 0) return;

		for (const rule of injectables) {
			output.output += formatRuleInjection(rule, phase);
			applied.add(createRuleKey(rule.id, phase));
		}
	};
}

export function resetRulesInjectorLiteState(): void {
	sessionAppliedRules.clear();
}
