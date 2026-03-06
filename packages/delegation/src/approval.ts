import { homedir, join } from "./bun-compat.js";

type ApprovalMode = "off" | "selected" | "all_mutating";

interface RawApprovalConfig {
	features?: {
		approvalGate?: boolean;
	};
	approval?: {
		mode?: ApprovalMode;
		tools?: string[];
		exemptTools?: string[];
		ttlMs?: number;
	};
}

interface ResolvedApprovalConfig {
	enabled: boolean;
	mode: ApprovalMode;
	tools: string[];
	exemptTools: string[];
	ttlMs: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const MUTATING_TOOLS = new Set(["background_cancel"]);
const grants = new Map<string, number>();

function normalizeToolList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}

function parseMode(value: unknown): ApprovalMode {
	if (value === "selected") return "selected";
	if (value === "all_mutating") return "all_mutating";
	return "off";
}

async function readConfig(path: string): Promise<RawApprovalConfig> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return {};
		return JSON.parse(await file.text()) as RawApprovalConfig;
	} catch {
		return {};
	}
}

export async function loadApprovalConfig(
	directory: string,
): Promise<ResolvedApprovalConfig> {
	const globalConfig = await readConfig(
		join(homedir(), ".config", "opencode", "workspace.json"),
	);
	const projectConfig = await readConfig(
		join(directory, ".opencode", "workspace.json"),
	);

	const mode = parseMode(
		projectConfig.approval?.mode ?? globalConfig.approval?.mode,
	);
	const tools = normalizeToolList(
		projectConfig.approval?.tools ?? globalConfig.approval?.tools,
	);
	const exemptTools = normalizeToolList(
		projectConfig.approval?.exemptTools ?? globalConfig.approval?.exemptTools,
	);
	const ttlMs = Math.max(
		0,
		Math.floor(
			projectConfig.approval?.ttlMs ??
				globalConfig.approval?.ttlMs ??
				DEFAULT_TTL_MS,
		),
	);
	const enabled =
		projectConfig.features?.approvalGate ??
		globalConfig.features?.approvalGate ??
		false;

	return {
		enabled,
		mode,
		tools,
		exemptTools,
		ttlMs,
	};
}

export async function enforceToolApproval(input: {
	directory: string;
	rootSessionID: string;
	toolName: string;
	reason: string;
	ask?: (input: {
		permission: string;
		patterns: string[];
		always?: string[];
		metadata?: Record<string, string | number | boolean>;
	}) => Promise<void>;
}): Promise<string | null> {
	const toolName = input.toolName.trim().toLowerCase();
	const cfg = await loadApprovalConfig(input.directory);
	if (!cfg.enabled || cfg.mode === "off") return null;
	if (cfg.exemptTools.includes(toolName)) return null;

	const shouldAsk =
		cfg.mode === "all_mutating"
			? MUTATING_TOOLS.has(toolName) || cfg.tools.includes(toolName)
			: cfg.tools.includes(toolName);
	if (!shouldAsk) return null;

	const cacheKey = `${input.rootSessionID}:${toolName}`;
	const expiresAt = grants.get(cacheKey);
	if (typeof expiresAt === "number" && expiresAt > Date.now()) {
		return null;
	}

	if (!input.ask) {
		return `❌ ${toolName} is approval-gated and cannot run because prompts are unavailable in this session.`;
	}

	await input.ask({
		permission: "task",
		patterns: [toolName],
		always: ["*"],
		metadata: {
			approval_gate: true,
			approval_tool: toolName,
			approval_reason: input.reason,
			approval_ttl_ms: cfg.ttlMs,
		},
	});

	grants.set(cacheKey, Date.now() + cfg.ttlMs);
	return null;
}
