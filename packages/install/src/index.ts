/**
 * op1 CLI Installer
 *
 * Interactive installer that scaffolds op1 config into user's ~/.config/opencode/.
 * Supports selective installation of components with config backup and merge.
 *
 * Uses Bun-native APIs exclusively (no node: imports).
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import {
	type BuilderMcpDefinition,
	type InstallMcpPointerArtifactsResult,
	installMcpPointerArtifacts,
	validateMcpPointerArtifacts,
} from "./mcp-pointer.js";
import {
	type EnsureWarmplaneBinaryResult,
	ensureWarmplaneBinary,
	isWarmplaneBinaryRecommendedDefault,
} from "./warmplane-binary.js";
import {
	buildWarmplaneConfig,
	buildWarmplanePointerAuthMetadata,
	extractRequiredEnvVars,
	filterFacadeMcps,
	isMcp0Selected,
	resolveWarmplaneAuthStorePath,
	resolveWarmplaneConfigPath,
	type WarmplaneConfig,
	type WarmplanePointerAuthMetadata,
} from "./warmplane-config.js";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");

function toPosixPath(input: string): string {
	return input.replace(/\\+/g, "/");
}

function isAbsolutePath(input: string): boolean {
	if (input.startsWith("/")) {
		return true;
	}

	return /^[A-Za-z]:\//.test(input);
}

function toNativePath(input: string): string {
	if (!IS_WINDOWS) {
		return input;
	}

	return input.replace(/\//g, "\\");
}

function joinPath(...parts: string[]): string {
	const normalized = parts
		.map((part) => part)
		.filter((part) => part.length > 0)
		.map((part) => toPosixPath(part));

	if (normalized.length === 0) {
		return "";
	}

	let result = normalized[0];
	for (let index = 1; index < normalized.length; index++) {
		const part = normalized[index];
		if (isAbsolutePath(part)) {
			result = part;
			continue;
		}

		const left = result.replace(/\/+$/, "");
		const right = part.replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return toNativePath(result);
}

function getHomeDirectory(): string {
	const homeDir = Bun.env.HOME;
	if (typeof homeDir === "string" && homeDir.length > 0) {
		return homeDir;
	}

	const userProfile = Bun.env.USERPROFILE;
	if (typeof userProfile === "string" && userProfile.length > 0) {
		return userProfile;
	}

	const homeDrive = Bun.env.HOMEDRIVE;
	const homePath = Bun.env.HOMEPATH;
	if (homeDrive && homePath) {
		return `${homeDrive}${homePath}`;
	}

	throw new Error("Could not resolve home directory from environment");
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const marker = joinPath(
		dirPath,
		`.op1-dir-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

async function listFilesRecursively(dirPath: string): Promise<string[]> {
	const files: string[] = [];
	for await (const file of new Bun.Glob("**/*").scan({
		cwd: dirPath,
		onlyFiles: true,
		absolute: false,
	})) {
		files.push(file);
	}

	return files;
}

const TEMPLATES_DIR = joinPath(import.meta.dir, "..", "templates");
const MODELS_API_URL = "https://models.dev/api.json";
const MODELS_API_TIMEOUT_MS = 10000;
const MODEL_SELECT_LIMIT = 120;
const MODEL_OPTION_CUSTOM = "__op7_custom_model__";
const MODEL_FAMILY_ALL = "__op7_all_families__";
const WORKSPACE_CONFIG_FILENAME = "workspace.json";
const LEGACY_SKILL_VAULT_PATH = "~/.config/opencode/skill-vault";

// =========================================
// MCP DEFINITIONS BY CATEGORY
// =========================================

interface McpConfig {
	type: "local" | "remote";
	command?: string[];
	url?: string;
	protocolVersion?: string;
	allowStateless?: boolean;
	headers?: Record<string, string>;
	environment?: Record<string, string>;
}

interface McpDefinition {
	id: string;
	name: string;
	description: string;
	config: McpConfig;
	toolPattern: string; // e.g., "linear_*"
	agentAccess: string[]; // which agents should have access
	required?: boolean;
	oauthCapable?: boolean;
	oauthConfig?: Omit<
		Extract<WarmplaneConfig["mcpServers"][string]["auth"], { type: "oauth" }>,
		"type" | "tokenStoreKey"
	>;
}

type McpCriticality = "required" | "optional";

interface McpCategory {
	id: string;
	name: string;
	description: string;
	requiresEnvVar?: string;
	requiredByDefault?: boolean;
	recommendedByDefault?: boolean;
	mcps: McpDefinition[];
}

function isCategoryRecommendedByDefault(category: McpCategory): boolean {
	if (category.id === "mcp0") {
		return (
			category.recommendedByDefault === true &&
			isWarmplaneBinaryRecommendedDefault()
		);
	}

	return category.recommendedByDefault === true;
}

const MCP_DEFAULT_CRITICALITY: McpCriticality = "optional";

function resolveMcpCriticality(
	category: McpCategory,
	mcp: McpDefinition,
): McpCriticality {
	if (typeof mcp.required === "boolean") {
		return mcp.required ? "required" : "optional";
	}

	if (category.requiredByDefault === true) {
		return "required";
	}

	return MCP_DEFAULT_CRITICALITY;
}

function getRequiredMcpDefinitions(categories: McpCategory[]): McpDefinition[] {
	const required = new Map<string, McpDefinition>();

	for (const category of categories) {
		for (const mcp of category.mcps) {
			if (resolveMcpCriticality(category, mcp) === "required") {
				required.set(mcp.id, mcp);
			}
		}
	}

	return [...required.values()];
}

function isFullyRequiredCategory(category: McpCategory): boolean {
	if (category.mcps.length === 0) {
		return false;
	}

	return category.mcps.every(
		(mcp) => resolveMcpCriticality(category, mcp) === "required",
	);
}

function getWarmplaneDownstreamMcps<T extends { id: string }>(mcps: T[]): T[] {
	return isMcp0Selected(mcps) ? filterFacadeMcps(mcps) : [];
}

function toMcpPointerDefinition(input: {
	mcp: McpDefinition;
	category: McpCategory;
	sourceConfigPath: string;
	authMetadata?: WarmplanePointerAuthMetadata;
}): BuilderMcpDefinition {
	return {
		id: input.mcp.id,
		name: input.mcp.name,
		toolPattern: input.mcp.toolPattern,
		required:
			resolveMcpCriticality(input.category, input.mcp) === "required"
				? "required"
				: "optional",
		config: input.mcp.config,
		oauthCapable: input.mcp.oauthCapable,
		authStatus: input.authMetadata?.authStatus,
		hasClientId: input.authMetadata?.hasClientId,
		hasClientSecret: input.authMetadata?.hasClientSecret,
		lastAuthErrorCode: input.authMetadata?.lastErrorCode,
		sourceConfigPath: input.sourceConfigPath,
	};
}

const MCP_CATEGORIES: McpCategory[] = [
	{
		id: "zai",
		name: "Z.AI Suite",
		description:
			"Vision, web search, reader, GitHub docs (requires Z_AI_API_KEY)",
		requiresEnvVar: "Z_AI_API_KEY",
		mcps: [
			{
				id: "zai-vision",
				name: "Vision",
				description: "Image/video analysis, UI screenshots",
				config: {
					type: "local",
					command: ["bunx", "-y", "@z_ai/mcp-server"],
					environment: {
						Z_AI_API_KEY: "{env:Z_AI_API_KEY}",
						Z_AI_MODE: "ZAI",
					},
				},
				toolPattern: "zai-vision_*",
				agentAccess: ["coder", "frontend"],
			},
			{
				id: "zai-search",
				name: "Web Search",
				description: "Real-time web search",
				config: {
					type: "remote",
					url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
					allowStateless: true,
					headers: { Authorization: "Bearer {env:Z_AI_API_KEY}" },
				},
				toolPattern: "zai-search_*",
				agentAccess: ["researcher"],
			},
			{
				id: "zai-reader",
				name: "Web Reader",
				description: "Fetch and parse webpage content",
				config: {
					type: "remote",
					url: "https://api.z.ai/api/mcp/web_reader/mcp",
					allowStateless: true,
					headers: { Authorization: "Bearer {env:Z_AI_API_KEY}" },
				},
				toolPattern: "zai-reader_*",
				agentAccess: ["researcher"],
			},
			{
				id: "zai-zread",
				name: "Zread",
				description: "GitHub repo understanding",
				config: {
					type: "remote",
					url: "https://api.z.ai/api/mcp/zread/mcp",
					allowStateless: true,
					headers: { Authorization: "Bearer {env:Z_AI_API_KEY}" },
				},
				toolPattern: "zai-zread_*",
				agentAccess: ["researcher"],
			},
		],
	},
	{
		id: "project-management",
		name: "Project Management",
		description: "Issue tracking and documentation (OAuth on first use)",
		mcps: [
			{
				id: "linear",
				name: "Linear",
				description: "Issue tracking",
				oauthCapable: true,
				oauthConfig: {
					authorizationServer: "https://api.linear.app",
					authorizationEndpoint: "https://linear.app/oauth/authorize",
					tokenEndpoint: "https://api.linear.app/oauth/token",
					codeChallengeMethodsSupported: ["S256"],
				},
				config: {
					type: "remote",
					url: "https://mcp.linear.app/mcp",
				},
				toolPattern: "linear_*",
				agentAccess: ["researcher"],
			},
			{
				id: "notion",
				name: "Notion",
				description: "Documentation and knowledge base",
				oauthCapable: true,
				config: {
					type: "local",
					command: ["bunx", "-y", "mcp-remote", "https://mcp.notion.com/mcp"],
				},
				toolPattern: "notion_*",
				agentAccess: ["researcher"],
			},
		],
	},
	{
		id: "observability",
		name: "Observability",
		description:
			"Application monitoring and performance (requires NEW_RELIC_API_KEY)",
		requiresEnvVar: "NEW_RELIC_API_KEY",
		mcps: [
			{
				id: "newrelic",
				name: "New Relic",
				description: "APM, monitoring, incident management",
				config: {
					type: "remote",
					url: "https://mcp.newrelic.com/mcp/",
					headers: {
						"api-key": "{env:NEW_RELIC_API_KEY}",
						"include-tags": "discovery,alerting",
					},
				},
				toolPattern: "newrelic_*",
				agentAccess: ["researcher"],
			},
		],
	},
	{
		id: "design",
		name: "Design",
		description:
			"Design system extraction and component specs (OAuth on first use)",
		mcps: [
			{
				id: "figma",
				name: "Figma",
				description: "Design tokens, components, assets",
				oauthCapable: true,
				config: {
					type: "remote",
					url: "https://mcp.figma.com/mcp",
				},
				toolPattern: "figma_*",
				agentAccess: ["researcher", "frontend"],
			},
			{
				id: "shadcn",
				name: "shadcn/ui",
				description: "Registry browsing, search, and component install",
				config: {
					type: "local",
					command: ["npx", "-y", "shadcn@latest", "mcp"],
				},
				toolPattern: "shadcn_*",
				agentAccess: ["researcher", "coder", "frontend"],
			},
			{
				id: "uidotsh",
				name: "ui.sh",
				description: "UI toolkit and design guidance for coding agents",
				config: {
					type: "remote",
					url: "https://ui.sh/mcp?agent=opencode",
					headers: {
						Authorization: "Bearer {env:UIDOTSH_TOKEN}",
					},
				},
				toolPattern: "uidotsh_*",
				agentAccess: ["build", "researcher", "coder", "frontend"],
			},
		],
	},
	{
		id: "mcp0",
		name: "mcp0 (Warmplane)",
		description:
			"Local MCP control-plane facade (compact, deterministic tool surface)",
		recommendedByDefault: true,
		mcps: [
			{
				id: "mcp0",
				name: "mcp0",
				description:
					"Warmplane facade server. Installs a managed macOS binary when available and writes a deterministic local mcp0 config.",
				config: {
					type: "local",
					command: ["warmplane", "mcp-server"],
				},
				toolPattern: "mcp0_*",
				agentAccess: ["build", "researcher", "coder", "frontend"],
			},
		],
	},
	{
		id: "utilities",
		name: "Utilities",
		description: "Library docs and code search (no auth required)",
		requiredByDefault: true,
		mcps: [
			{
				id: "context7",
				name: "Context7",
				description: "Library/docs lookup",
				config: {
					type: "remote",
					url: "https://mcp.context7.com/mcp",
				},
				toolPattern: "context7_*",
				agentAccess: ["researcher", "coder", "frontend"],
			},
			{
				id: "grep_app",
				name: "Grep.app",
				description: "GitHub code search",
				config: {
					type: "remote",
					url: "https://mcp.grep.app",
					protocolVersion: "2024-11-05",
					allowStateless: true,
				},
				toolPattern: "grep_app_*",
				agentAccess: ["researcher"],
			},
		],
	},
];

// =========================================
// TYPES
// =========================================

interface InstallOptions {
	agents: boolean;
	commands: boolean;
	skills: boolean;
	plugins: boolean;
}

interface MainOptions {
	dryRun?: boolean;
}

interface PluginChoice {
	workspace: boolean;
	delegation: boolean;
	reprompt: boolean;
	astGrep: boolean;
	lsp: boolean;
}

type InstallerProfile = "standard" | "beta-lean";

interface InstallerProfileDefaults {
	pluginChoices: PluginChoice;
	workspaceConfig: WorkspacePluginConfig;
}

// Agent model configuration - per-agent
interface AgentModelConfig {
	[agentName: string]: string | null;
}

// All agents that can have models configured
const ALL_AGENTS = [
	"backend",
	"build",
	"coder",
	"explore",
	"frontend",
	"infra",
	"oracle",
	"plan",
	"researcher",
	"reviewer",
	"scribe",
] as const;

// Default models - all null (use global model)
const DEFAULT_AGENT_MODELS: AgentModelConfig = {};

interface AgentConfig {
	tools?: Record<string, boolean>;
	model?: string;
	[key: string]: unknown;
}

interface WorkspaceFeatureFlags {
	momentum?: boolean;
	completionPromise?: boolean;
	writePolicy?: boolean;
	taskReminder?: boolean;
	autonomyPolicy?: boolean;
	notifications?: boolean;
	verificationAutopilot?: boolean;
	hashAnchoredEdit?: boolean;
	contextScout?: boolean;
	externalScout?: boolean;
	taskGraph?: boolean;
	continuationCommands?: boolean;
	tmuxOrchestration?: boolean;
	boundaryPolicyV2?: boolean;
	mcpOAuthHelper?: boolean;
}

interface WorkspaceThresholds {
	taskReminderThreshold?: number;
	contextLimit?: number;
	compactionThreshold?: number;
	verificationThrottleMs?: number;
}

interface WorkspaceNotifications {
	enabled?: boolean;
	desktop?: boolean;
	quietHours?: string;
	timezone?: string;
	privacy?: "strict" | "balanced";
}

interface WorkspaceVerification {
	autopilot?: boolean;
	throttleMs?: number;
}

interface WorkspaceMcpPointer {
	enabled?: boolean;
	mode?: "legacy-only" | "pointer-only" | "mixed";
}

interface WorkspacePluginConfig {
	disabledHooks?: string[];
	safeHookCreation?: boolean;
	features?: WorkspaceFeatureFlags;
	thresholds?: WorkspaceThresholds;
	notifications?: WorkspaceNotifications;
	verification?: WorkspaceVerification;
	mcpPointer?: WorkspaceMcpPointer;
	[key: string]: unknown;
}

interface OpenCodeConfig {
	$schema?: string;
	plugin?: string[];
	model?: string;
	small_model?: string;
	default_agent?: string;
	permission?: Record<string, string>;
	mcp?: Record<string, McpConfig>;
	skills?: {
		paths?: string[];
		urls?: string[];
	};
	tools?: Record<string, boolean>;
	agent?: Record<string, AgentConfig>;
	compaction?: { auto?: boolean; prune?: boolean };
	provider?: Record<string, unknown>;
	[key: string]: unknown;
}

function cloneAgentConfig(
	agent?: Record<string, AgentConfig>,
): Record<string, AgentConfig> | undefined {
	if (!agent) return undefined;
	return Object.fromEntries(
		Object.entries(agent).map(([name, config]) => [
			name,
			{
				...config,
				tools: config.tools ? { ...config.tools } : undefined,
			},
		]),
	);
}

function applyMcp0FacadeMode(input: {
	config: OpenCodeConfig;
	warmplaneConfigPath: string;
	warmplaneBinaryPath: string;
}): OpenCodeConfig {
	const next: OpenCodeConfig = {
		...input.config,
		mcp: { ...(input.config.mcp || {}) },
		tools: { ...(input.config.tools || {}) },
		agent: cloneAgentConfig(input.config.agent) || {},
	};

	for (const id of Object.keys(next.mcp || {})) {
		if (id === "mcp0") continue;
		delete next.mcp?.[id];
	}

	const removedPatterns = new Set(
		Object.keys(next.tools || {}).filter((pattern) => pattern !== "mcp0_*"),
	);
	for (const id of Object.keys(input.config.mcp || {})) {
		if (id === "mcp0") continue;
		removedPatterns.add(`${id.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`);
	}

	for (const pattern of removedPatterns) {
		if (pattern === "mcp0_*") continue;
		delete next.tools?.[pattern];
	}
	for (const config of Object.values(next.agent || {})) {
		for (const pattern of removedPatterns) {
			if (pattern === "mcp0_*") continue;
			delete config.tools?.[pattern];
		}
	}

	next.mcp = next.mcp || {};
	next.mcp.mcp0 = {
		type: "local",
		command: [
			input.warmplaneBinaryPath,
			"mcp-server",
			"--config",
			input.warmplaneConfigPath,
		],
	};

	next.tools = next.tools || {};
	if (next.tools["mcp0_*"] === undefined) {
		next.tools["mcp0_*"] = false;
	}

	return next;
}

const DEFAULT_WORKSPACE_CONFIG: WorkspacePluginConfig = {
	disabledHooks: [],
	safeHookCreation: false,
	features: {
		momentum: true,
		completionPromise: true,
		writePolicy: true,
		taskReminder: true,
		autonomyPolicy: true,
		notifications: true,
		verificationAutopilot: true,
		hashAnchoredEdit: true,
		contextScout: true,
		externalScout: true,
		taskGraph: true,
		continuationCommands: true,
		tmuxOrchestration: true,
		boundaryPolicyV2: true,
		mcpOAuthHelper: true,
	},
	thresholds: {
		taskReminderThreshold: 20,
		contextLimit: 200000,
		compactionThreshold: 0.78,
		verificationThrottleMs: 45000,
	},
	notifications: {
		enabled: true,
		desktop: true,
		quietHours: "",
		timezone: "",
		privacy: "strict",
	},
	verification: {
		autopilot: true,
		throttleMs: 45000,
	},
	mcpPointer: {
		enabled: true,
		mode: "mixed",
	},
};

const INSTALLER_PROFILE_DEFAULTS: Record<
	InstallerProfile,
	InstallerProfileDefaults
> = {
	standard: {
		pluginChoices: {
			workspace: true,
			delegation: true,
			reprompt: false,
			astGrep: true,
			lsp: true,
		},
		workspaceConfig: DEFAULT_WORKSPACE_CONFIG,
	},
	"beta-lean": {
		pluginChoices: {
			workspace: true,
			delegation: true,
			reprompt: false,
			astGrep: false,
			lsp: false,
		},
		workspaceConfig: {
			...DEFAULT_WORKSPACE_CONFIG,
			features: {
				...(DEFAULT_WORKSPACE_CONFIG.features || {}),
				taskGraph: true,
				continuationCommands: true,
				mcpOAuthHelper: false,
			},
		},
	},
};

function resolveDefaultPluginChoices(
	profile: InstallerProfile,
	pluginsEnabled: boolean,
): PluginChoice {
	const defaults = INSTALLER_PROFILE_DEFAULTS[profile].pluginChoices;
	return {
		workspace: defaults.workspace,
		delegation: pluginsEnabled ? defaults.delegation : false,
		reprompt: pluginsEnabled ? defaults.reprompt : false,
		astGrep: pluginsEnabled ? defaults.astGrep : false,
		lsp: pluginsEnabled ? defaults.lsp : false,
	};
}

function mergeWorkspaceConfig(
	config: WorkspacePluginConfig | undefined,
	profile: InstallerProfile = "standard",
): WorkspacePluginConfig {
	const profileDefaults = INSTALLER_PROFILE_DEFAULTS[profile].workspaceConfig;
	const {
		skillPointer: _removedSkillPointer,
		approval: _removedApproval,
		...restConfig
	} = config || {};
	const rawFeatures = (restConfig.features || {}) as Record<string, unknown>;
	const { approvalGate: _removedApprovalGate, ...restFeatures } = rawFeatures;

	return {
		...profileDefaults,
		...restConfig,
		disabledHooks: [
			...(profileDefaults.disabledHooks || []),
			...(restConfig.disabledHooks || []),
		],
		features: {
			...(profileDefaults.features || {}),
			...restFeatures,
		},
		thresholds: {
			...(profileDefaults.thresholds || {}),
			...(restConfig.thresholds || {}),
		},
		notifications: {
			...(profileDefaults.notifications || {}),
			...(restConfig.notifications || {}),
		},
		verification: {
			...(profileDefaults.verification || {}),
			...(restConfig.verification || {}),
		},
		mcpPointer: {
			...(profileDefaults.mcpPointer || {}),
			...(restConfig.mcpPointer || {}),
		},
	};
}

interface ModelCatalogModel {
	id: string;
	name: string;
	family: string;
}

interface ModelCatalogProvider {
	id: string;
	name: string;
	models: ModelCatalogModel[];
}

// =========================================
// UTILITY FUNCTIONS (Bun-native)
// =========================================

async function copyDir(src: string, dest: string): Promise<number> {
	await ensureDirectory(dest);

	const files = await listFilesRecursively(src);
	for (const relativeFile of files) {
		const srcPath = joinPath(src, relativeFile);
		const destPath = joinPath(dest, relativeFile);
		await Bun.write(destPath, Bun.file(srcPath));
	}

	return files.length;
}

async function countDirFiles(src: string): Promise<number> {
	const files = await listFilesRecursively(src);
	return files.length;
}

async function resolveTemplateSource(
	pluralName: string,
	singularName: string,
): Promise<string | null> {
	const srcPlural = joinPath(TEMPLATES_DIR, pluralName);
	const srcSingular = joinPath(TEMPLATES_DIR, singularName);
	if (await dirExists(srcPlural)) {
		return srcPlural;
	}
	if (await dirExists(srcSingular)) {
		return srcSingular;
	}
	return null;
}

async function fileExists(filePath: string): Promise<boolean> {
	return await Bun.file(filePath).exists();
}

async function dirExists(dirPath: string): Promise<boolean> {
	try {
		for await (const _entry of new Bun.Glob("*").scan({
			cwd: dirPath,
			onlyFiles: false,
			absolute: false,
		})) {
			break;
		}
		return true;
	} catch {
		return false;
	}
}

interface ReadJsonResult<T> {
	data: T | null;
	error: "not_found" | "parse_error" | null;
	rawError?: Error;
}

async function readJsonFile<T>(filePath: string): Promise<ReadJsonResult<T>> {
	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) {
			return { data: null, error: "not_found" };
		}
		const content = await file.text();
		// Strip JSONC comments (single-line only for simplicity)
		const stripped = content
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/,(\s*[}\]])/g, "$1");
		return { data: JSON.parse(stripped), error: null };
	} catch (err) {
		const error = err as Error;
		return { data: null, error: "parse_error", rawError: error };
	}
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function getTimestamp(): string {
	return Date.now().toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeModelFamily(value: unknown): string {
	if (typeof value !== "string") {
		return "other";
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : "other";
}

function countCatalogModels(catalog: ModelCatalogProvider[]): number {
	return catalog.reduce((sum, provider) => sum + provider.models.length, 0);
}

async function fetchModelCatalog(): Promise<ModelCatalogProvider[] | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MODELS_API_TIMEOUT_MS);

	try {
		const response = await fetch(MODELS_API_URL, {
			signal: controller.signal,
		});

		if (!response.ok) {
			return null;
		}

		const raw = (await response.json()) as unknown;
		if (!isRecord(raw)) {
			return null;
		}

		const providers: ModelCatalogProvider[] = [];

		for (const [providerID, providerValue] of Object.entries(raw)) {
			if (!isRecord(providerValue) || !isRecord(providerValue.models)) {
				continue;
			}

			const modelMap = new Map<string, ModelCatalogModel>();
			for (const [modelKey, modelValue] of Object.entries(
				providerValue.models,
			)) {
				if (!isRecord(modelValue)) {
					continue;
				}

				const modelIDRaw =
					typeof modelValue.id === "string" && modelValue.id.trim().length > 0
						? modelValue.id.trim()
						: modelKey.trim();

				if (!modelIDRaw) {
					continue;
				}

				const modelName =
					typeof modelValue.name === "string" &&
					modelValue.name.trim().length > 0
						? modelValue.name.trim()
						: modelIDRaw;

				modelMap.set(modelIDRaw, {
					id: modelIDRaw,
					name: modelName,
					family: normalizeModelFamily(modelValue.family),
				});
			}

			const models = [...modelMap.values()].sort((a, b) =>
				a.id.localeCompare(b.id),
			);
			if (models.length === 0) {
				continue;
			}

			const providerName =
				typeof providerValue.name === "string" &&
				providerValue.name.trim().length > 0
					? providerValue.name.trim()
					: providerID;

			providers.push({
				id: providerID,
				name: providerName,
				models,
			});
		}

		if (providers.length === 0) {
			return null;
		}

		return providers.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

async function promptManualModelInput(
	message: string,
	defaultModel: string,
): Promise<string | symbol> {
	return await p.text({
		message,
		placeholder: defaultModel,
		defaultValue: defaultModel,
		validate: (value) =>
			value.trim().length === 0 ? "Model cannot be empty" : undefined,
	});
}

async function promptModelSelection(
	message: string,
	defaultModel: string,
	modelCatalog: ModelCatalogProvider[] | null,
	lastSelectedModel?: string,
): Promise<string | symbol> {
	if (!modelCatalog || modelCatalog.length === 0) {
		return await promptManualModelInput(message, defaultModel);
	}

	type SourceChoice = "default" | "catalog" | "custom" | "reuse";
	const sourceOptions: Array<{
		value: SourceChoice;
		label: string;
		hint?: string;
	}> = [
		{
			value: "default",
			label: `Use suggested: ${defaultModel}`,
			hint: "recommended",
		},
		{
			value: "catalog",
			label: "Choose from models.dev",
			hint: `${modelCatalog.length} providers`,
		},
		{
			value: "custom",
			label: "Enter model manually",
			hint: "type model id",
		},
	];

	if (lastSelectedModel) {
		sourceOptions.splice(1, 0, {
			value: "reuse",
			label: `Reuse previous: ${lastSelectedModel}`,
			hint: "faster setup",
		});
	}

	const sourceChoice = await p.select({
		message,
		options: sourceOptions,
		initialValue: "default",
	});

	if (p.isCancel(sourceChoice)) {
		return sourceChoice;
	}

	if (sourceChoice === "default") {
		return defaultModel;
	}

	if (sourceChoice === "reuse" && lastSelectedModel) {
		return lastSelectedModel;
	}

	if (sourceChoice === "custom") {
		return await promptManualModelInput("Enter model manually:", defaultModel);
	}

	const providerChoice = await p.select({
		message: "Select model provider",
		options: modelCatalog.map((provider) => ({
			value: provider.id,
			label: provider.name,
			hint: `${provider.models.length} models`,
		})),
		maxItems: 12,
	});

	if (p.isCancel(providerChoice)) {
		return providerChoice;
	}

	const provider = modelCatalog.find((item) => item.id === providerChoice);
	if (!provider) {
		return await promptManualModelInput("Enter model manually:", defaultModel);
	}

	const familyMap = new Map<string, ModelCatalogModel[]>();
	for (const model of provider.models) {
		const family = model.family || "other";
		const bucket = familyMap.get(family) || [];
		bucket.push(model);
		familyMap.set(family, bucket);
	}

	const familyEntries = [...familyMap.entries()].sort((a, b) => {
		if (b[1].length !== a[1].length) {
			return b[1].length - a[1].length;
		}
		return a[0].localeCompare(b[0]);
	});

	const familyChoice = await p.select({
		message: `Select model family (${provider.name})`,
		options: [
			{
				value: MODEL_FAMILY_ALL,
				label: "All families",
				hint: `${provider.models.length} models`,
			},
			...familyEntries.map(([family, models]) => ({
				value: family,
				label: family,
				hint: `${models.length} models`,
			})),
		],
		initialValue: MODEL_FAMILY_ALL,
		maxItems: 12,
	});

	if (p.isCancel(familyChoice)) {
		return familyChoice;
	}

	let modelPool =
		familyChoice === MODEL_FAMILY_ALL
			? provider.models
			: familyMap.get(familyChoice) || provider.models;

	if (modelPool.length > MODEL_SELECT_LIMIT) {
		const filterInput = await p.text({
			message: `${provider.name} has ${modelPool.length} models. Filter list (optional):`,
			placeholder: "gpt-5, claude, gemini, qwen...",
			defaultValue: "",
		});

		if (p.isCancel(filterInput)) {
			return filterInput;
		}

		const filterTerm = filterInput.trim().toLowerCase();
		if (filterTerm.length > 0) {
			modelPool = modelPool.filter(
				(model) =>
					model.id.toLowerCase().includes(filterTerm) ||
					model.name.toLowerCase().includes(filterTerm),
			);
		}

		if (modelPool.length === 0) {
			p.log.warn(
				"No catalog models matched that filter. Falling back to manual input.",
			);
			return await promptManualModelInput(
				"Enter model manually:",
				defaultModel,
			);
		}
	}

	let truncated = false;
	if (modelPool.length > MODEL_SELECT_LIMIT) {
		modelPool = modelPool.slice(0, MODEL_SELECT_LIMIT);
		truncated = true;
	}

	if (truncated) {
		p.log.warn(
			`Showing first ${MODEL_SELECT_LIMIT} models. Use filter keywords for narrower selection.`,
		);
	}

	const selectedModel = await p.select({
		message: `Select model (${provider.name})`,
		options: [
			...modelPool.map((model) => ({
				value: model.id,
				label: model.id,
				hint: model.name !== model.id ? model.name : undefined,
			})),
			{
				value: MODEL_OPTION_CUSTOM,
				label: "Enter model manually",
				hint: "type full model id",
			},
		],
		initialValue: modelPool.some((model) => model.id === defaultModel)
			? defaultModel
			: undefined,
		maxItems: 12,
	});

	if (p.isCancel(selectedModel)) {
		return selectedModel;
	}

	if (selectedModel === MODEL_OPTION_CUSTOM) {
		return await promptManualModelInput("Enter model manually:", defaultModel);
	}

	return selectedModel;
}

// =========================================
// BACKUP FUNCTIONS (Bun-native)
// =========================================

async function backupConfigFile(configFile: string): Promise<string | null> {
	try {
		const file = Bun.file(configFile);
		if (!(await file.exists())) return null;

		const backupPath = configFile.replace(
			".json",
			`.${getTimestamp()}.json.bak`,
		);
		await Bun.write(backupPath, file);
		return backupPath;
	} catch {
		return null;
	}
}

// =========================================
// CONFIG MERGE FUNCTIONS
// =========================================

function mergeConfig(
	existing: OpenCodeConfig | null,
	originalConfig: OpenCodeConfig | null, // Always passed to preserve provider
	selectedMcps: McpDefinition[],
	pluginChoices: PluginChoice,
	agentModels: AgentModelConfig,
	globalModel: string | null, // Global model when user skips per-agent config
	allAgents: string[], // All agent names to ensure they're in config
): OpenCodeConfig {
	const base: OpenCodeConfig = existing || {
		$schema: "https://opencode.ai/config.json",
	};

	// 0. ALWAYS preserve critical settings from original config (even with backup-replace)
	if (originalConfig) {
		// Preserve provider
		if (originalConfig.provider && !base.provider) {
			base.provider = originalConfig.provider;
		}
		// Preserve existing plugins (merge, don't replace)
		if (originalConfig.plugin && !base.plugin) {
			base.plugin = [...originalConfig.plugin];
		}
		// Preserve existing MCPs (merge, don't replace)
		if (originalConfig.mcp && !base.mcp) {
			base.mcp = { ...originalConfig.mcp };
		}
		// Preserve existing tools config
		if (originalConfig.tools && !base.tools) {
			base.tools = { ...originalConfig.tools };
		}
		// Preserve existing skill sources
		if (originalConfig.skills && !base.skills) {
			base.skills = {
				paths: originalConfig.skills.paths
					? originalConfig.skills.paths.filter(
							(path) => path !== LEGACY_SKILL_VAULT_PATH,
						)
					: undefined,
				urls: originalConfig.skills.urls
					? [...originalConfig.skills.urls]
					: undefined,
			};
		}
		// Preserve existing agent config (deep-merge per-agent properties)
		if (originalConfig.agent && !base.agent) {
			base.agent = {};
			for (const [agentName, agentConf] of Object.entries(
				originalConfig.agent,
			)) {
				base.agent[agentName] = {
					...agentConf,
					tools: agentConf.tools ? { ...agentConf.tools } : undefined,
				};
			}
		} else if (originalConfig.agent && base.agent) {
			// Deep-merge: preserve original agent settings not already in base
			for (const [agentName, agentConf] of Object.entries(
				originalConfig.agent,
			)) {
				if (!base.agent[agentName]) {
					base.agent[agentName] = {
						...agentConf,
						tools: agentConf.tools ? { ...agentConf.tools } : undefined,
					};
				} else {
					// Merge individual properties (model, temperature, etc.)
					for (const [key, value] of Object.entries(agentConf)) {
						if (key === "tools") {
							// Deep-merge tools
							base.agent[agentName].tools = {
								...(agentConf.tools || {}),
								...(base.agent[agentName].tools || {}),
							};
						} else if (base.agent[agentName][key] === undefined) {
							base.agent[agentName][key] = value;
						}
					}
				}
			}
		}
		// Preserve model settings
		if (originalConfig.model && !base.model) {
			base.model = originalConfig.model;
		}
		if (originalConfig.small_model && !base.small_model) {
			base.small_model = originalConfig.small_model;
		}
		if (originalConfig.default_agent && !base.default_agent) {
			base.default_agent = originalConfig.default_agent;
		}
		// Preserve compaction settings
		if (originalConfig.compaction && !base.compaction) {
			base.compaction = originalConfig.compaction;
		}
		// Preserve permissions
		if (originalConfig.permission && !base.permission) {
			base.permission = originalConfig.permission;
		}
	}

	if (base.skills?.paths) {
		base.skills = {
			...base.skills,
			paths: base.skills.paths.filter(
				(path) => path !== LEGACY_SKILL_VAULT_PATH,
			),
		};
	}

	// 1. Merge plugins (add op1 plugins if not already present)
	const existingPlugins = base.plugin || [];
	const newPlugins: string[] = [];
	if (pluginChoices.workspace && !existingPlugins.includes("@op1/workspace")) {
		newPlugins.push("@op1/workspace");
	}
	if (
		pluginChoices.delegation &&
		!existingPlugins.includes("@op1/delegation")
	) {
		newPlugins.push("@op1/delegation");
	}
	if (pluginChoices.reprompt && !existingPlugins.includes("@op1/reprompt")) {
		newPlugins.push("@op1/reprompt");
	}
	if (pluginChoices.astGrep && !existingPlugins.includes("@op1/ast-grep")) {
		newPlugins.push("@op1/ast-grep");
	}
	if (pluginChoices.lsp && !existingPlugins.includes("@op1/lsp")) {
		newPlugins.push("@op1/lsp");
	}
	if (newPlugins.length > 0 || existingPlugins.length > 0) {
		base.plugin = [...existingPlugins, ...newPlugins];
	}

	// 2. Don't set model/small_model/default_agent - let user configure these themselves
	// (removed: we no longer add default model settings)

	// 3. Preserve existing permissions (don't add defaults - let OpenCode handle it)
	// Only keep if user already has them configured
	// (removed: we no longer add default permissions)

	// 4. Merge MCP servers
	base.mcp = base.mcp || {};
	for (const mcp of selectedMcps) {
		// Only add if not already present
		if (!base.mcp[mcp.id]) {
			base.mcp[mcp.id] = mcp.config;
		}
	}

	// 5. Merge tool visibility (disable by default, agents enable)
	base.tools = base.tools || {};
	for (const mcp of selectedMcps) {
		// Set to false if not already configured
		if (base.tools[mcp.toolPattern] === undefined) {
			base.tools[mcp.toolPattern] = false;
		}
	}

	// 6. Merge agent config (tools + models)
	base.agent = base.agent || {};

	// Build agent -> tools mapping from selected MCPs
	const agentTools: Record<string, string[]> = {};
	for (const mcp of selectedMcps) {
		for (const agent of mcp.agentAccess) {
			if (!agentTools[agent]) {
				agentTools[agent] = [];
			}
			agentTools[agent].push(mcp.toolPattern);
		}
	}

	// Apply agent tool overrides
	for (const [agentName, tools] of Object.entries(agentTools)) {
		if (!base.agent[agentName]) {
			base.agent[agentName] = {};
		}
		if (!base.agent[agentName].tools) {
			base.agent[agentName].tools = {};
		}
		const toolConfig = base.agent[agentName].tools;
		if (!toolConfig) {
			continue;
		}
		for (const tool of tools) {
			// Only set to true if not already configured
			if (toolConfig[tool] === undefined) {
				toolConfig[tool] = true;
			}
		}
	}

	// 6. Set global model if provided
	if (globalModel && !base.model) {
		base.model = globalModel;
	}

	// 7. Ensure all agents are in the config (with or without models)
	for (const agentName of allAgents) {
		if (!base.agent[agentName]) {
			base.agent[agentName] = {};
		}
	}

	// 8. Merge agent models (per-agent configuration)
	// Only add models that were explicitly configured
	for (const [agentName, model] of Object.entries(agentModels)) {
		if (model) {
			if (!base.agent[agentName]) {
				base.agent[agentName] = {};
			}
			// Only set if not already configured (preserve user's existing choice)
			if (!base.agent[agentName].model) {
				base.agent[agentName].model = model;
			}
		}
	}

	// 9. Merge compaction (only add if not present)
	if (!base.compaction) {
		base.compaction = { auto: true, prune: true };
	}

	return base;
}

// =========================================
// MAIN INSTALLER
// =========================================

export async function main(mainOptions: MainOptions = {}) {
	const dryRun =
		mainOptions.dryRun ??
		(Bun.argv.includes("--dry-run") || Bun.argv.includes("-n"));

	console.clear();

	p.intro(
		`${pc.bgCyan(pc.black(" op1 "))} ${pc.dim(`OpenCode harness installer${dryRun ? " (dry run)" : ""}`)}`,
	);

	// Determine target directory
	const homeDir = getHomeDirectory();
	const globalConfigDir = joinPath(homeDir, ".config", "opencode");
	const globalConfigFile = joinPath(globalConfigDir, "opencode.json");
	const warmplaneConfigFile = resolveWarmplaneConfigPath(globalConfigDir);
	const warmplaneConfigDir = joinPath(globalConfigDir, "mcp0");
	const warmplaneAuthStorePath = resolveWarmplaneAuthStorePath(homeDir);
	const workspaceConfigFile = joinPath(
		globalConfigDir,
		WORKSPACE_CONFIG_FILENAME,
	);

	// Check for existing installation
	const configDirExists = await dirExists(globalConfigDir);
	const configFileResult = await readJsonFile<OpenCodeConfig>(globalConfigFile);
	const workspaceConfigResult =
		await readJsonFile<WorkspacePluginConfig>(workspaceConfigFile);

	let existingJson: OpenCodeConfig | null = null;
	let existingWorkspaceConfig: WorkspacePluginConfig | null =
		workspaceConfigResult.error === null ? workspaceConfigResult.data : null;
	let configBackupPath: string | null = null;
	let workspaceConfigBackupPath: string | null = null;

	// Determine the actual state
	const hasConfigFile = configFileResult.error !== "not_found";
	const hasValidConfig =
		configFileResult.data !== null && configFileResult.error === null;
	const hasMalformedConfig = configFileResult.error === "parse_error";

	if (configDirExists) {
		// Handle malformed JSON first
		if (hasMalformedConfig) {
			p.log.error(
				`${pc.red("Malformed config")} at ${pc.dim(globalConfigFile)}`,
			);
			if (configFileResult.rawError) {
				p.log.error(`  ${pc.dim(configFileResult.rawError.message)}`);
			}

			const action = await p.select({
				message:
					"Your opencode.json has syntax errors. How would you like to proceed?",
				options: [
					{
						value: "backup-replace",
						label: "Backup and replace",
						hint: "Creates backup, installs fresh config (recommended)",
					},
					{
						value: "cancel",
						label: "Cancel",
						hint: "Fix the JSON manually first",
					},
				],
			});

			if (p.isCancel(action) || action === "cancel") {
				p.cancel("Please fix the JSON errors and try again.");
				return;
			}

			// Create backup of malformed config
			if (dryRun) {
				configBackupPath = `${globalConfigFile.replace(".json", `.${getTimestamp()}.json.bak`)} (dry-run)`;
				p.log.info(`Would create config backup: ${pc.dim(configBackupPath)}`);
			} else {
				configBackupPath = await backupConfigFile(globalConfigFile);
				if (configBackupPath) {
					p.log.success(`Config backup: ${pc.dim(configBackupPath)}`);
				}
			}
			existingJson = null; // Start fresh
		}
		// Handle valid config
		else if (hasValidConfig) {
			p.log.info(
				`${pc.yellow("Found existing config")} at ${pc.dim(globalConfigDir)}`,
			);

			// ALWAYS create backup before any changes
			if (dryRun) {
				configBackupPath = `${globalConfigFile.replace(".json", `.${getTimestamp()}.json.bak`)} (dry-run)`;
				p.log.info(`Would create config backup: ${pc.dim(configBackupPath)}`);
			} else {
				configBackupPath = await backupConfigFile(globalConfigFile);
				if (configBackupPath) {
					p.log.success(`Config backup: ${pc.dim(configBackupPath)}`);
				}
			}

			const action = await p.select({
				message: "How would you like to proceed?",
				options: [
					{
						value: "merge",
						label: "Merge with existing",
						hint: "Preserves your settings, adds op1 components",
					},
					{
						value: "backup-replace",
						label: "Replace config",
						hint: "Start fresh (backup already created)",
					},
					{
						value: "cancel",
						label: "Cancel",
						hint: "Exit without changes",
					},
				],
			});

			if (p.isCancel(action) || action === "cancel") {
				p.cancel("Installation cancelled.");
				return;
			}

			if (action === "merge") {
				existingJson = configFileResult.data;
			} else {
				existingJson = null; // Start fresh
			}
		}
		// Handle directory exists but no config file
		else if (!hasConfigFile) {
			p.log.info(
				`${pc.yellow("Found config directory")} at ${pc.dim(globalConfigDir)} (no opencode.json)`,
			);

			const shouldContinue = await p.confirm({
				message: "Add op1 configuration to this directory?",
				initialValue: true,
			});

			if (p.isCancel(shouldContinue) || !shouldContinue) {
				p.cancel("Installation cancelled.");
				return;
			}
			existingJson = null; // Fresh config
		}
	}

	if (workspaceConfigResult.error === "parse_error") {
		p.log.warn(
			`${pc.yellow("Malformed workspace config")} at ${pc.dim(workspaceConfigFile)}`,
		);
		if (workspaceConfigResult.rawError) {
			p.log.warn(`  ${pc.dim(workspaceConfigResult.rawError.message)}`);
		}

		if (dryRun) {
			workspaceConfigBackupPath = `${workspaceConfigFile.replace(".json", `.${getTimestamp()}.json.bak`)} (dry-run)`;
			p.log.info(
				`Would create workspace config backup: ${pc.dim(workspaceConfigBackupPath)}`,
			);
		} else {
			workspaceConfigBackupPath = await backupConfigFile(workspaceConfigFile);
			if (workspaceConfigBackupPath) {
				p.log.success(
					`Workspace config backup: ${pc.dim(workspaceConfigBackupPath)}`,
				);
			}
		}

		existingWorkspaceConfig = null;
	}

	// Component selection
	p.log.info(pc.dim("Use ↑↓ to navigate, space to toggle, enter to confirm"));
	const components = await p.multiselect({
		message: "What would you like to install?",
		options: [
			{
				value: "agents",
				label: "Agents",
				hint: "11 specialized agents (build, coder, explore, etc.)",
			},
			{
				value: "commands",
				label: "Commands",
				hint: "Curated slash commands (/init, /plan, /work, /review, etc.)",
			},
			{
				value: "skills",
				label: "Skills",
				hint: "Curated loadable skills (code-philosophy, long-running-workflows, playwright, etc.)",
			},
			{
				value: "plugins",
				label: "Plugins",
				hint: "Workspace, delegation, and optional code tooling plugins",
			},
		],
		initialValues: ["agents", "commands", "skills", "plugins"],
		required: true,
	});

	if (p.isCancel(components)) {
		p.cancel("Installation cancelled.");
		return;
	}

	const options: InstallOptions = {
		agents: components.includes("agents"),
		commands: components.includes("commands"),
		skills: components.includes("skills"),
		plugins: components.includes("plugins"),
	};

	const installerProfile = await p.select<InstallerProfile>({
		message: "Choose installer profile",
		options: [
			{
				value: "standard",
				label: "Standard",
				hint: "Current default behavior",
			},
			{
				value: "beta-lean",
				label: "OpenCode beta lean",
				hint: "Conservative plugin and workspace defaults",
			},
		],
		initialValue: "standard",
	});

	if (p.isCancel(installerProfile)) {
		p.cancel("Installation cancelled.");
		return;
	}

	// Plugin selection - workspace and delegation are included by default, others optional
	const pluginChoices = resolveDefaultPluginChoices(
		installerProfile,
		options.plugins,
	);
	if (options.plugins) {
		const wantDelegation = await p.confirm({
			message:
				"Enable task delegation plugin? (async task, background_output, background_cancel)",
			initialValue:
				INSTALLER_PROFILE_DEFAULTS[installerProfile].pluginChoices.delegation,
		});

		if (!p.isCancel(wantDelegation)) {
			pluginChoices.delegation = wantDelegation;
		}

		const wantReprompt = await p.confirm({
			message:
				"Enable reprompt plugin? (incoming prompt compiler + bounded child-session retry helper)",
			initialValue:
				INSTALLER_PROFILE_DEFAULTS[installerProfile].pluginChoices.reprompt,
		});

		if (!p.isCancel(wantReprompt)) {
			pluginChoices.reprompt = wantReprompt;
		}

		const wantAstGrep = await p.confirm({
			message:
				"Enable AST-grep? (structural code search/replace, 25 languages)",
			initialValue:
				INSTALLER_PROFILE_DEFAULTS[installerProfile].pluginChoices.astGrep,
		});

		if (!p.isCancel(wantAstGrep)) {
			pluginChoices.astGrep = wantAstGrep;
		}

		const wantLsp = await p.confirm({
			message:
				"Enable LSP tools? (go-to-definition, find-references, 50+ language servers)",
			initialValue:
				INSTALLER_PROFILE_DEFAULTS[installerProfile].pluginChoices.lsp,
		});

		if (!p.isCancel(wantLsp)) {
			pluginChoices.lsp = wantLsp;
		}
	}

	// MCP Category selection
	p.log.info(`\n${pc.bold("MCP Server Configuration")}`);

	// Include required MCPs from the contract by default.
	const requiredMcps = getRequiredMcpDefinitions(MCP_CATEGORIES);
	const selectedMcps: McpDefinition[] = [...requiredMcps];

	const optionalCategories = MCP_CATEGORIES.filter(
		(category) => !isFullyRequiredCategory(category),
	);

	if (optionalCategories.length > 0) {
		if (requiredMcps.length > 0) {
			p.log.info(
				pc.dim(
					`Required MCPs are included by default: ${requiredMcps.map((mcp) => mcp.name).join(", ")}.`,
				),
			);
		}
		if (optionalCategories.some((category) => category.id === "mcp0")) {
			p.log.info(
				pc.dim(
					"If you enable mcp0 (Warmplane), every other MCP you choose here is written as a downstream server in ~/.config/opencode/mcp0/mcp_servers.json and accessed through the compact mcp0_* facade.",
				),
			);
		}
		p.log.info(pc.dim("Use ↑↓ to navigate, space to toggle, enter to confirm"));

		const selectedCategories = await p.multiselect({
			message:
				"Select MCP categories to install (mcp0 routes the other picks through Warmplane)",
			options: optionalCategories.map((cat) => ({
				value: cat.id,
				label: cat.name,
				hint: isCategoryRecommendedByDefault(cat)
					? `${cat.description} (recommended default)`
					: cat.description,
			})),
			initialValues: optionalCategories
				.filter((category) => isCategoryRecommendedByDefault(category))
				.map((category) => category.id),
			required: false,
		});

		if (p.isCancel(selectedCategories)) {
			p.cancel("Installation cancelled.");
			return;
		}

		// Add all MCPs from selected categories
		for (const categoryId of selectedCategories) {
			const category = optionalCategories.find((c) => c.id === categoryId);
			if (!category) continue;

			// Check for required env var
			if (category.requiresEnvVar) {
				const hasEnvVar = Bun.env[category.requiresEnvVar];
				if (!hasEnvVar) {
					p.log.warn(
						`${pc.yellow(category.name)} requires ${pc.cyan(category.requiresEnvVar)} environment variable`,
					);
				}
			}

			// Add all MCPs from the selected category
			for (const mcp of category.mcps) {
				selectedMcps.push(mcp);
			}
			p.log.success(
				`Added ${category.name}: ${category.mcps.map((m) => m.name).join(", ")}`,
			);
		}

		const warmplaneDownstreamMcps = getWarmplaneDownstreamMcps(selectedMcps);
		if (warmplaneDownstreamMcps.length > 0) {
			p.log.info(
				pc.dim(
					`Warmplane downstream MCPs: ${warmplaneDownstreamMcps.map((mcp) => mcp.name).join(", ")}.`,
				),
			);
		}
	}

	// Agent Model Configuration (only if agents are being installed)
	const agentModels: AgentModelConfig = { ...DEFAULT_AGENT_MODELS };

	// All agent names - we'll ensure all are in the config
	const allAgents = [...ALL_AGENTS];

	// Track global model for when user skips per-agent config
	let globalModelToSet: string | null = null;

	if (options.agents) {
		p.log.info(`\n${pc.bold("Agent Model Configuration")}`);

		const modelCatalogSpinner = p.spinner();
		modelCatalogSpinner.start("Fetching model catalog from models.dev...");
		const modelCatalog = await fetchModelCatalog();
		if (modelCatalog) {
			modelCatalogSpinner.stop(
				`Loaded ${countCatalogModels(modelCatalog)} models from ${modelCatalog.length} providers`,
			);
			p.log.info(
				pc.dim(
					"Use dropdowns to select models, or choose manual entry anytime.",
				),
			);
		} else {
			modelCatalogSpinner.stop("Could not load models.dev catalog");
			p.log.warn("Falling back to manual model entry.");
		}

		const configureModels = await p.confirm({
			message: "Configure per-agent models?",
			initialValue: false,
		});

		if (!p.isCancel(configureModels) && configureModels) {
			// Agent descriptions and suggested models
			const agentPrompts: {
				name: string;
				desc: string;
				defaultModel: string;
			}[] = [
				{
					name: "backend",
					desc: "Backend (APIs/services specialist)",
					defaultModel: "proxy/claude-opus-4-5-thinking",
				},
				{
					name: "build",
					desc: "Build agent (default, writes code)",
					defaultModel: "proxy/claude-opus-4-5-thinking",
				},
				{
					name: "coder",
					desc: "Coder (atomic coding tasks)",
					defaultModel: "proxy/claude-opus-4-5-thinking",
				},
				{
					name: "frontend",
					desc: "Frontend (UI/UX specialist)",
					defaultModel: "proxy/gemini-3-pro-high",
				},
				{
					name: "infra",
					desc: "Infra (Terraform/IaC specialist)",
					defaultModel: "proxy/claude-opus-4-5-thinking",
				},
				{
					name: "plan",
					desc: "Plan (strategic planning)",
					defaultModel: "proxy/claude-opus-4-5-thinking",
				},
				{
					name: "oracle",
					desc: "Oracle (architecture, debugging)",
					defaultModel: "quotio/gpt-5.2-codex",
				},
				{
					name: "reviewer",
					desc: "Reviewer (code review)",
					defaultModel: "quotio/gpt-5.2-codex",
				},
				{
					name: "explore",
					desc: "Explore (codebase search)",
					defaultModel: "proxy/gemini-3-flash",
				},
				{
					name: "researcher",
					desc: "Researcher (external docs)",
					defaultModel: "proxy/gemini-3-flash",
				},
				{
					name: "scribe",
					desc: "Scribe (documentation)",
					defaultModel: "proxy/gemini-3-flash",
				},
			];

			let lastSelectedModel: string | undefined;

			for (const agent of agentPrompts) {
				const model = await promptModelSelection(
					`${agent.desc}:`,
					agent.defaultModel,
					modelCatalog,
					lastSelectedModel,
				);

				if (!p.isCancel(model) && model.trim()) {
					const normalized = model.trim();
					agentModels[agent.name] = normalized;
					lastSelectedModel = normalized;
				}
			}
		} else {
			// User skipped per-agent config - ask for global model
			const globalModel = await promptModelSelection(
				"Global model for all agents:",
				"anthropic/claude-sonnet-4-20250514",
				modelCatalog,
			);

			if (!p.isCancel(globalModel) && globalModel.trim()) {
				globalModelToSet = globalModel.trim();
			}
		}
	}

	// Installation
	const s = p.spinner();
	s.start(
		dryRun ? "Simulating op1 installation..." : "Installing op1 components...",
	);

	let totalFiles = 0;
	let mergedConfig: OpenCodeConfig | null = null;
	let mergedWorkspaceConfig: WorkspacePluginConfig | null = null;
	let mcpPointerResult: InstallMcpPointerArtifactsResult | null = null;
	let mcpPointerFallbackReason: string | null = null;
	let warmplaneConfig: WarmplaneConfig | null = null;
	let warmplaneBinaryResult: EnsureWarmplaneBinaryResult | null = null;

	try {
		const originalConfig = configFileResult.data;
		mergedWorkspaceConfig = mergeWorkspaceConfig(
			existingWorkspaceConfig ?? undefined,
			installerProfile,
		);
		mergedConfig = mergeConfig(
			existingJson,
			originalConfig,
			selectedMcps,
			pluginChoices,
			agentModels,
			globalModelToSet,
			allAgents,
		);
		const facadeMode = isMcp0Selected(selectedMcps);
		const facadeMcps: McpDefinition[] = facadeMode
			? selectedMcps.filter((mcp) => mcp.id !== "mcp0")
			: selectedMcps;
		let warmplanePointerAuthMetadata: Record<
			string,
			WarmplanePointerAuthMetadata
		> = {};
		if (facadeMode) {
			warmplaneBinaryResult = await ensureWarmplaneBinary({
				homeDir,
				dryRun,
			});
			warmplaneConfig = buildWarmplaneConfig({
				mcps: facadeMcps,
				authStorePath: warmplaneAuthStorePath,
			});
			warmplanePointerAuthMetadata = await buildWarmplanePointerAuthMetadata({
				config: warmplaneConfig,
			});
			mergedConfig = applyMcp0FacadeMode({
				config: mergedConfig,
				warmplaneConfigPath: warmplaneConfigFile,
				warmplaneBinaryPath: warmplaneBinaryResult.binaryPath,
			});
		}

		const totalCatalogMcpCount = MCP_CATEGORIES.reduce(
			(sum, category) => sum + category.mcps.length,
			0,
		);
		const selectedMcpPointerDefs: BuilderMcpDefinition[] = facadeMcps
			.map((mcp) => {
				const category = MCP_CATEGORIES.find((entry) =>
					entry.mcps.some((candidate) => candidate.id === mcp.id),
				);
				if (!category) {
					return null;
				}

				return toMcpPointerDefinition({
					mcp,
					category,
					sourceConfigPath: facadeMode ? warmplaneConfigFile : globalConfigFile,
					authMetadata: facadeMode
						? warmplanePointerAuthMetadata[mcp.id]
						: undefined,
				});
			})
			.filter((entry): entry is BuilderMcpDefinition => entry !== null);
		const mcpPointerEnabled =
			mergedWorkspaceConfig.mcpPointer?.enabled !== false;

		const installTargets: Array<{
			enabled: boolean;
			pluralName: string;
			singularName: string;
			destination: string;
		}> = [
			{
				enabled: true,
				pluralName: "themes",
				singularName: "theme",
				destination: joinPath(globalConfigDir, "themes"),
			},
			{
				enabled: options.agents,
				pluralName: "agents",
				singularName: "agent",
				destination: joinPath(globalConfigDir, "agents"),
			},
			{
				enabled: options.commands,
				pluralName: "commands",
				singularName: "command",
				destination: joinPath(globalConfigDir, "commands"),
			},
			{
				enabled: options.skills,
				pluralName: "skills",
				singularName: "skill",
				destination: joinPath(globalConfigDir, "skills"),
			},
		];

		if (dryRun) {
			for (const target of installTargets) {
				if (!target.enabled) {
					continue;
				}

				const src = await resolveTemplateSource(
					target.pluralName,
					target.singularName,
				);
				if (!src) {
					continue;
				}

				totalFiles += await countDirFiles(src);
			}

			if (mcpPointerEnabled) {
				try {
					mcpPointerResult = await installMcpPointerArtifacts({
						configDir: globalConfigDir,
						mcps: selectedMcpPointerDefs,
						totalCatalogMcpCount,
						dryRun: true,
					});
					totalFiles += mcpPointerResult.fileWrites;
				} catch (error) {
					mcpPointerFallbackReason =
						error instanceof Error ? error.message : String(error);
					mergedWorkspaceConfig.mcpPointer = {
						...(mergedWorkspaceConfig.mcpPointer || {}),
						enabled: false,
					};
				}
			}

			if (warmplaneConfig) {
				totalFiles += 1;
			}

			totalFiles += 2; // opencode.json + workspace.json writes
			s.stop(`Dry run complete. Would install ${totalFiles} files.`);
		} else {
			// Create config directory
			await ensureDirectory(globalConfigDir);

			for (const target of installTargets) {
				if (!target.enabled) {
					continue;
				}

				const src = await resolveTemplateSource(
					target.pluralName,
					target.singularName,
				);
				if (!src) {
					continue;
				}

				totalFiles += await copyDir(src, target.destination);
			}

			if (mcpPointerEnabled) {
				try {
					mcpPointerResult = await installMcpPointerArtifacts({
						configDir: globalConfigDir,
						mcps: selectedMcpPointerDefs,
						totalCatalogMcpCount,
					});

					const integrity = await validateMcpPointerArtifacts({
						indexPath: mcpPointerResult.indexPath,
						checksumPath: mcpPointerResult.checksumPath,
					});
					if (!integrity.ok) {
						throw new Error(
							integrity.issues
								.map((issue) => `${issue.code}: ${issue.message}`)
								.join("; "),
						);
					}

					totalFiles += mcpPointerResult.fileWrites;
				} catch (error) {
					mcpPointerFallbackReason =
						error instanceof Error ? error.message : String(error);
					mergedWorkspaceConfig.mcpPointer = {
						...(mergedWorkspaceConfig.mcpPointer || {}),
						enabled: false,
					};
					mcpPointerResult = null;
				}
			}

			if (warmplaneConfig) {
				await ensureDirectory(warmplaneConfigDir);
				await writeJsonFile(warmplaneConfigFile, warmplaneConfig);
				totalFiles += 1;
			}

			// Write merged config
			await writeJsonFile(globalConfigFile, mergedConfig);
			await writeJsonFile(workspaceConfigFile, mergedWorkspaceConfig);
			totalFiles += 2;

			s.stop(`Installed ${totalFiles} files`);
		}
	} catch (error) {
		s.stop(dryRun ? "Dry run failed" : "Installation failed");
		throw error;
	}

	// Summary
	const summaryLines: string[] = [];
	const installVerb = dryRun ? "would be installed" : "installed";
	const configVerb = dryRun ? "would be configured" : "configured";

	if (configBackupPath) {
		summaryLines.push(
			`${pc.blue("↩")} Config backup ${dryRun ? "would be" : ""} created: ${pc.dim(configBackupPath)}`.replace(
				"  ",
				" ",
			),
		);
	}
	if (workspaceConfigBackupPath) {
		summaryLines.push(
			`${pc.blue("↩")} Workspace config backup ${dryRun ? "would be" : ""} created: ${pc.dim(workspaceConfigBackupPath)}`.replace(
				"  ",
				" ",
			),
		);
	}
	if (options.agents) {
		summaryLines.push(
			`${pc.green("✓")} Agents ${installVerb} to ${pc.dim("~/.config/opencode/agents/")}`,
		);
	}
	if (options.commands) {
		summaryLines.push(
			`${pc.green("✓")} Commands ${installVerb} to ${pc.dim("~/.config/opencode/commands/")}`,
		);
	}
	if (options.skills) {
		summaryLines.push(
			`${pc.green("✓")} Skills ${installVerb} to ${pc.dim("~/.config/opencode/skills/")}`,
		);
	}
	summaryLines.push(
		`${pc.green("✓")} Themes ${installVerb} to ${pc.dim("~/.config/opencode/themes/")}`,
	);
	if (options.plugins) {
		summaryLines.push(
			`${pc.green("✓")} Plugins ${configVerb} in opencode.json`,
		);
	}
	summaryLines.push(
		`${pc.green("✓")} Workspace defaults ${configVerb} in ${pc.dim("~/.config/opencode/workspace.json")}`,
	);
	if (selectedMcps.length > 0) {
		summaryLines.push(
			`${pc.green("✓")} MCPs ${configVerb}: ${selectedMcps.map((m) => pc.cyan(m.name)).join(", ")}`,
		);
	}
	if (warmplaneConfig) {
		summaryLines.push(
			`${pc.green("✓")} Warmplane ${dryRun ? "would scaffold" : "scaffolded"} strict mcp0-only config at ${pc.dim("~/.config/opencode/mcp0/mcp_servers.json")}`,
		);
		const warmplaneDownstreamNames = Object.keys(warmplaneConfig.mcpServers);
		if (warmplaneDownstreamNames.length > 0) {
			summaryLines.push(
				`${pc.green("✓")} Warmplane downstream MCPs ${configVerb}: ${warmplaneDownstreamNames.map((name) => pc.cyan(name)).join(", ")}`,
			);
		}
	}
	if (warmplaneBinaryResult) {
		const actionText =
			warmplaneBinaryResult.status === "reused"
				? "reused"
				: warmplaneBinaryResult.status === "path"
					? "resolved from PATH"
					: dryRun
						? "would install"
						: "installed";
		summaryLines.push(
			`${pc.green("✓")} Warmplane mac binary ${actionText} at ${pc.dim(warmplaneBinaryResult.binaryPath)}`,
		);
	}
	if (mcpPointerResult) {
		summaryLines.push(
			`${pc.green("✓")} MCP pointer ${dryRun ? "would generate" : "generated"} ${pc.cyan(String(mcpPointerResult.activeMcpCount))} active entries (${pc.cyan(String(mcpPointerResult.deferredMcpCount))} deferred) at ${pc.dim("~/.config/opencode/.mcp-pointer/index.json")}`,
		);
	}
	if (mcpPointerFallbackReason) {
		summaryLines.push(
			`${pc.yellow("⚠")} MCP pointer ${dryRun ? "preview failed" : "failed"}; continuing in legacy MCP mode. Reason: ${mcpPointerFallbackReason}`,
		);
	}
	if (dryRun) {
		summaryLines.push(`${pc.yellow("⚑")} Dry run mode: no files were written`);
	}

	p.note(
		summaryLines.join("\n"),
		dryRun ? "Dry run complete" : "Installation complete",
	);

	if (dryRun && mergedConfig && mergedWorkspaceConfig) {
		const pluginList = (mergedConfig.plugin || []).join(", ") || "(none)";
		const mcpList = Object.keys(mergedConfig.mcp || {}).join(", ") || "(none)";
		const workspaceFlags = Object.entries(mergedWorkspaceConfig.features || {})
			.filter((entry) => entry[1] === true)
			.map((entry) => entry[0])
			.join(", ");
		const configuredAgents =
			Object.entries(agentModels)
				.filter(([, model]) => Boolean(model))
				.map(([agent]) => agent)
				.join(", ") || "(none)";

		p.note(
			[
				`Config target: ${pc.dim(globalConfigFile)}`,
				...(warmplaneConfig
					? [`Warmplane config target: ${pc.dim(warmplaneConfigFile)}`]
					: []),
				...(warmplaneBinaryResult
					? [
							`Warmplane binary target: ${pc.dim(warmplaneBinaryResult.binaryPath)}`,
						]
					: []),
				`Workspace config target: ${pc.dim(workspaceConfigFile)}`,
				`Plugins: ${pc.cyan(pluginList)}`,
				`Workspace enabled flags: ${pc.cyan(workspaceFlags || "(none)")}`,
				`MCP IDs: ${pc.cyan(mcpList)}`,
				`Global model: ${pc.cyan(globalModelToSet || mergedConfig.model || "(none)")}`,
				`Per-agent models: ${pc.cyan(configuredAgents)}`,
			].join("\n"),
			"Dry run config preview",
		);
	}

	// Show any required env vars (based on selected MCPs)
	const selectedCategoryIds = [
		...new Set(
			selectedMcps
				.map(
					(mcp) =>
						MCP_CATEGORIES.find((c) => c.mcps.some((m) => m.id === mcp.id))?.id,
				)
				.filter(Boolean),
		),
	] as string[];

	const requiredEnvVars = MCP_CATEGORIES.filter((category) =>
		selectedCategoryIds.includes(category.id),
	)
		.map((category) => category.requiresEnvVar)
		.filter(
			(requiresEnvVar): requiresEnvVar is string =>
				typeof requiresEnvVar === "string" && requiresEnvVar.length > 0,
		);
	const warmplaneRequiredEnvVars = warmplaneConfig
		? extractRequiredEnvVars(warmplaneConfig)
		: [];
	const allRequiredEnvVars = [
		...new Set([...requiredEnvVars, ...warmplaneRequiredEnvVars]),
	];

	const missingEnvVars = allRequiredEnvVars.filter(
		(requiresEnvVar) => !Bun.env[requiresEnvVar],
	);

	if (missingEnvVars.length > 0) {
		p.log.warn(
			`\n${pc.yellow("⚠")} Set these environment variables for full functionality:\n` +
				missingEnvVars.map((v) => `  ${pc.cyan(v)}`).join("\n"),
		);
	}

	p.outro(
		dryRun
			? `Dry run finished. Re-run without ${pc.cyan("--dry-run")} to apply changes.`
			: `Run ${pc.cyan("opencode")} to start coding with op1!`,
	);
}

export {
	applyMcp0FacadeMode,
	buildWarmplaneConfig,
	copyDir,
	extractRequiredEnvVars,
	fileExists,
	filterFacadeMcps,
	mergeConfig,
	mergeWorkspaceConfig,
	getWarmplaneDownstreamMcps,
	MCP_CATEGORIES,
	resolveDefaultPluginChoices,
	getRequiredMcpDefinitions,
	isMcp0Selected,
	resolveMcpCriticality,
	resolveWarmplaneAuthStorePath,
	resolveWarmplaneConfigPath,
};
export type {
	InstallOptions,
	InstallerProfile,
	PluginChoice,
	McpCriticality,
	McpDefinition,
	McpCategory,
	OpenCodeConfig,
	WorkspacePluginConfig,
};
