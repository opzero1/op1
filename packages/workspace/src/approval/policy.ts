export type ApprovalMode = "off" | "selected" | "all_mutating";

export type ApprovalNonInteractiveBehavior = "fail-closed";

export type ApprovalRiskTier = "high" | "medium";

export interface ApprovalPolicyConfig {
	mode?: ApprovalMode;
	tools?: string[];
	exemptTools?: string[];
	ttlMs?: number;
	nonInteractive?: ApprovalNonInteractiveBehavior;
}

export interface ResolvedApprovalPolicy {
	mode: ApprovalMode;
	tools: string[];
	exemptTools: string[];
	ttlMs: number;
	nonInteractive: ApprovalNonInteractiveBehavior;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

const DEFAULT_SELECTED_TOOLS = [
	"plan_archive",
	"delegation_cancel",
	"worktree_delete",
] as const;

const MUTATING_TOOLS = [
	"plan_archive",
	"plan_unarchive",
	"delegation_cancel",
	"worktree_create",
	"worktree_enter",
	"worktree_leave",
	"worktree_delete",
] as const;

const TOOL_RISK_TIERS: Record<string, ApprovalRiskTier> = {
	plan_archive: "high",
	plan_unarchive: "medium",
	delegation_cancel: "high",
	worktree_create: "medium",
	worktree_enter: "medium",
	worktree_leave: "medium",
	worktree_delete: "high",
};

function normalizeToolList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const normalized = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => normalizeApprovalToolName(entry))
		.filter((entry) => entry.length > 0);

	return [...new Set(normalized)];
}

export function normalizeApprovalToolName(value: string): string {
	return value.trim().toLowerCase();
}

function parseApprovalMode(value: unknown): ApprovalMode {
	if (value === "off") return "off";
	if (value === "selected") return "selected";
	if (value === "all_mutating") return "all_mutating";
	return "off";
}

function parseNonInteractiveBehavior(
	value: unknown,
): ApprovalNonInteractiveBehavior {
	if (value === "fail-closed") return "fail-closed";
	return "fail-closed";
}

function parseTTL(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_TTL_MS;
	}

	const rounded = Math.floor(value);
	if (rounded <= 0) return 0;
	return Math.min(rounded, MAX_TTL_MS);
}

export function resolveApprovalPolicy(
	config?: ApprovalPolicyConfig,
): ResolvedApprovalPolicy {
	const mode = parseApprovalMode(config?.mode);
	const selected = normalizeToolList(config?.tools);
	const exemptTools = normalizeToolList(config?.exemptTools);

	const tools = selected.length > 0 ? selected : [...DEFAULT_SELECTED_TOOLS];

	return {
		mode,
		tools: [...new Set(tools)],
		exemptTools,
		ttlMs: parseTTL(config?.ttlMs),
		nonInteractive: parseNonInteractiveBehavior(config?.nonInteractive),
	};
}

export function getApprovalRiskTier(toolName: string): ApprovalRiskTier | null {
	const normalized = normalizeApprovalToolName(toolName);
	return TOOL_RISK_TIERS[normalized] ?? null;
}

export function shouldEnforceApproval(input: {
	toolName: string;
	featureEnabled: boolean;
	policy: ResolvedApprovalPolicy;
}): boolean {
	if (!input.featureEnabled) return false;
	if (input.policy.mode === "off") return false;

	const normalizedTool = normalizeApprovalToolName(input.toolName);
	if (!normalizedTool) return false;

	if (input.policy.exemptTools.includes(normalizedTool)) {
		return false;
	}

	if (input.policy.mode === "selected") {
		return input.policy.tools.includes(normalizedTool);
	}

	if (
		MUTATING_TOOLS.includes(normalizedTool as (typeof MUTATING_TOOLS)[number])
	) {
		return true;
	}

	return input.policy.tools.includes(normalizedTool);
}
