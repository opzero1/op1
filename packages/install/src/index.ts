/**
 * op1 CLI Installer
 *
 * Interactive installer that scaffolds op1 config into user's ~/.config/opencode/.
 * Supports selective installation of components with config backup and merge.
 *
 * Uses Bun-native APIs exclusively (no node: imports).
 */

import { mkdir, readdir } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import * as p from "@clack/prompts";
import pc from "picocolors";

const TEMPLATES_DIR = join(import.meta.dir, "..", "templates");

// =========================================
// MCP DEFINITIONS BY CATEGORY
// =========================================

interface McpConfig {
	type: "local" | "remote";
	command?: string[];
	url?: string;
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
}

interface McpCategory {
	id: string;
	name: string;
	description: string;
	requiresEnvVar?: string;
	mcps: McpDefinition[];
}

const MCP_CATEGORIES: McpCategory[] = [
	{
		id: "zai",
		name: "Z.AI Suite",
		description: "Vision, web search, reader, GitHub docs (requires Z_AI_API_KEY)",
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
				config: {
					type: "local",
					command: ["bunx", "-y", "mcp-remote", "https://mcp.linear.app/mcp"],
				},
				toolPattern: "linear_*",
				agentAccess: ["researcher"],
			},
			{
				id: "notion",
				name: "Notion",
				description: "Documentation and knowledge base",
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
		description: "Application monitoring and performance (requires NEW_RELIC_API_KEY)",
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
		description: "Design system extraction and component specs (OAuth on first use)",
		mcps: [
			{
				id: "figma",
				name: "Figma",
				description: "Design tokens, components, assets",
				config: {
					type: "remote",
					url: "https://mcp.figma.com/mcp",
				},
				toolPattern: "figma_*",
				agentAccess: ["researcher", "frontend"],
			},
		],
	},
	{
		id: "utilities",
		name: "Utilities",
		description: "Library docs and code search (no auth required)",
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

interface PluginChoice {
	notify: boolean;
	workspace: boolean;
	astGrep: boolean;
	lsp: boolean;
	semanticSearch: boolean;
	codeGraph: boolean;
}

// Agent model configuration - per-agent
interface AgentModelConfig {
	[agentName: string]: string | null;
}

// All agents that can have models configured
const ALL_AGENTS = [
	"build",
	"coder", 
	"explore",
	"frontend",
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

interface OpenCodeConfig {
	$schema?: string;
	plugin?: string[];
	model?: string;
	small_model?: string;
	default_agent?: string;
	permission?: Record<string, string>;
	mcp?: Record<string, McpConfig>;
	tools?: Record<string, boolean>;
	agent?: Record<string, AgentConfig>;
	compaction?: { auto?: boolean; prune?: boolean };
	provider?: Record<string, unknown>;
	[key: string]: unknown;
}

// =========================================
// UTILITY FUNCTIONS (Bun-native)
// =========================================

async function copyDir(src: string, dest: string): Promise<number> {
	let count = 0;
	await mkdir(dest, { recursive: true });

	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);

		if (entry.isDirectory()) {
			count += await copyDir(srcPath, destPath);
		} else {
			// Bun-native file copy
			await Bun.write(destPath, Bun.file(srcPath));
			count++;
		}
	}
	return count;
}

async function fileExists(filePath: string): Promise<boolean> {
	return await Bun.file(filePath).exists();
}

async function dirExists(dirPath: string): Promise<boolean> {
	try {
		const entries = await readdir(dirPath);
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
		const stripped = content.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
		return { data: JSON.parse(stripped), error: null };
	} catch (err) {
		const error = err as Error;
		return { data: null, error: "parse_error", rawError: error };
	}
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	await Bun.write(filePath, JSON.stringify(data, null, 2) + "\n");
}

function getTimestamp(): string {
	return Date.now().toString();
}

// =========================================
// BACKUP FUNCTIONS (Bun-native)
// =========================================

async function backupConfigFile(configFile: string): Promise<string | null> {
	try {
		const file = Bun.file(configFile);
		if (!(await file.exists())) return null;
		
		const backupPath = configFile.replace(".json", `.${getTimestamp()}.json.bak`);
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
	allAgents: string[] // All agent names to ensure they're in config
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
		// Preserve existing agent config
		if (originalConfig.agent && !base.agent) {
			base.agent = { ...originalConfig.agent };
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

	// 1. Merge plugins (add op1 plugins if not already present)
	const existingPlugins = base.plugin || [];
	const newPlugins: string[] = [];
	if (pluginChoices.notify && !existingPlugins.includes("@op1/notify")) {
		newPlugins.push("@op1/notify");
	}
	if (pluginChoices.workspace && !existingPlugins.includes("@op1/workspace")) {
		newPlugins.push("@op1/workspace");
	}
	if (pluginChoices.astGrep && !existingPlugins.includes("@op1/ast-grep")) {
		newPlugins.push("@op1/ast-grep");
	}
	if (pluginChoices.lsp && !existingPlugins.includes("@op1/lsp")) {
		newPlugins.push("@op1/lsp");
	}
	if (pluginChoices.semanticSearch && !existingPlugins.includes("@op1/semantic-search")) {
		newPlugins.push("@op1/semantic-search");
	}
	if (pluginChoices.codeGraph && !existingPlugins.includes("@op1/code-graph")) {
		newPlugins.push("@op1/code-graph");
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
		for (const tool of tools) {
			// Only set to true if not already configured
			if (base.agent[agentName].tools![tool] === undefined) {
				base.agent[agentName].tools![tool] = true;
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

export async function main() {
	console.clear();

	p.intro(
		`${pc.bgCyan(pc.black(" op1 "))} ${pc.dim("OpenCode harness installer")}`,
	);

	// Determine target directory
	const homeDir = homedir();
	const globalConfigDir = join(homeDir, ".config", "opencode");
	const globalConfigFile = join(globalConfigDir, "opencode.json");

	// Check for existing installation
	const configDirExists = await dirExists(globalConfigDir);
	const configFileResult = await readJsonFile<OpenCodeConfig>(globalConfigFile);
	
	let existingJson: OpenCodeConfig | null = null;
	let configBackupPath: string | null = null;

	// Determine the actual state
	const hasConfigFile = configFileResult.error !== "not_found";
	const hasValidConfig = configFileResult.data !== null && configFileResult.error === null;
	const hasMalformedConfig = configFileResult.error === "parse_error";

	if (configDirExists) {
		// Handle malformed JSON first
		if (hasMalformedConfig) {
			p.log.error(`${pc.red("Malformed config")} at ${pc.dim(globalConfigFile)}`);
			if (configFileResult.rawError) {
				p.log.error(`  ${pc.dim(configFileResult.rawError.message)}`);
			}
			
			const action = await p.select({
				message: "Your opencode.json has syntax errors. How would you like to proceed?",
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
				process.exit(0);
			}

			// Create backup of malformed config
			configBackupPath = await backupConfigFile(globalConfigFile);
			if (configBackupPath) {
				p.log.success(`Config backup: ${pc.dim(configBackupPath)}`);
			}
			existingJson = null; // Start fresh
		}
		// Handle valid config
		else if (hasValidConfig) {
			p.log.info(`${pc.yellow("Found existing config")} at ${pc.dim(globalConfigDir)}`);
			
			// ALWAYS create backup before any changes
			configBackupPath = await backupConfigFile(globalConfigFile);
			if (configBackupPath) {
				p.log.success(`Config backup: ${pc.dim(configBackupPath)}`);
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
				process.exit(0);
			}

			if (action === "merge") {
				existingJson = configFileResult.data;
			} else {
				existingJson = null; // Start fresh
			}
		}
		// Handle directory exists but no config file
		else if (!hasConfigFile) {
			p.log.info(`${pc.yellow("Found config directory")} at ${pc.dim(globalConfigDir)} (no opencode.json)`);
			
			const shouldContinue = await p.confirm({
				message: "Add op1 configuration to this directory?",
				initialValue: true,
			});

			if (p.isCancel(shouldContinue) || !shouldContinue) {
				p.cancel("Installation cancelled.");
				process.exit(0);
			}
			existingJson = null; // Fresh config
		}
	}

	// Component selection
	p.log.info(pc.dim("Use ↑↓ to navigate, space to toggle, enter to confirm"));
	const components = await p.multiselect({
		message: "What would you like to install?",
		options: [
			{
				value: "agents",
				label: "Agents",
				hint: "9 specialized agents (build, coder, explore, etc.)",
			},
			{
				value: "commands",
				label: "Commands",
				hint: "6 slash commands (/plan, /review, /ulw, etc.)",
			},
			{
				value: "skills",
				label: "Skills",
				hint: "17 loadable skills (code-philosophy, playwright, etc.)",
			},
			{
				value: "plugins",
				label: "Plugins",
				hint: "Notify + Workspace plugins",
			},
		],
		initialValues: ["agents", "commands", "skills", "plugins"],
		required: true,
	});

	if (p.isCancel(components)) {
		p.cancel("Installation cancelled.");
		process.exit(0);
	}

	const options: InstallOptions = {
		agents: components.includes("agents"),
		commands: components.includes("commands"),
		skills: components.includes("skills"),
		plugins: components.includes("plugins"),
	};

	// Plugin selection - workspace is always included, others optional
	let pluginChoices: PluginChoice = { notify: false, workspace: true, astGrep: false, lsp: false, semanticSearch: false, codeGraph: false };
	if (options.plugins) {
		const wantNotify = await p.confirm({
			message: "Enable desktop notifications? (sounds, focus detection, quiet hours)",
			initialValue: true,
		});

		if (!p.isCancel(wantNotify)) {
			pluginChoices.notify = wantNotify;
		}

		const wantAstGrep = await p.confirm({
			message: "Enable AST-grep? (structural code search/replace, 25 languages)",
			initialValue: true,
		});

		if (!p.isCancel(wantAstGrep)) {
			pluginChoices.astGrep = wantAstGrep;
		}

		const wantLsp = await p.confirm({
			message: "Enable LSP tools? (go-to-definition, find-references, 50+ language servers)",
			initialValue: true,
		});

		if (!p.isCancel(wantLsp)) {
			pluginChoices.lsp = wantLsp;
		}

		const wantSemanticSearch = await p.confirm({
			message: "Enable semantic search? (natural language code search with embeddings)",
			initialValue: true,
		});

		if (!p.isCancel(wantSemanticSearch)) {
			pluginChoices.semanticSearch = wantSemanticSearch;
		}

		const wantCodeGraph = await p.confirm({
			message: "Enable code graph? (dependency analysis, impact assessment)",
			initialValue: true,
		});

		if (!p.isCancel(wantCodeGraph)) {
			pluginChoices.codeGraph = wantCodeGraph;
		}
	}

	// MCP Category selection
	p.log.info(`\n${pc.bold("MCP Server Configuration")}`);
	
	// Always include utilities (context7, grep_app) - they're essential
	const utilitiesCategory = MCP_CATEGORIES.find((c) => c.id === "utilities");
	const selectedMcps: McpDefinition[] = utilitiesCategory ? [...utilitiesCategory.mcps] : [];
	
	// Ask about optional categories (excluding utilities which is always included)
	const optionalCategories = MCP_CATEGORIES.filter((c) => c.id !== "utilities");
	
	if (optionalCategories.length > 0) {
		p.log.info(pc.dim("Context7 and Grep.app are included by default."));
		p.log.info(pc.dim("Use ↑↓ to navigate, space to toggle, enter to confirm"));
		
		const selectedCategories = await p.multiselect({
			message: "Enable additional MCP categories?",
			options: optionalCategories.map((cat) => ({
				value: cat.id,
				label: cat.name,
				hint: cat.description,
			})),
			initialValues: [],
			required: false,
		});

		if (p.isCancel(selectedCategories)) {
			p.cancel("Installation cancelled.");
			process.exit(0);
		}

		// Add all MCPs from selected categories
		for (const categoryId of selectedCategories) {
			const category = optionalCategories.find((c) => c.id === categoryId);
			if (!category) continue;

			// Check for required env var
			if (category.requiresEnvVar) {
				const hasEnvVar = process.env[category.requiresEnvVar];
				if (!hasEnvVar) {
					p.log.warn(
						`${pc.yellow(category.name)} requires ${pc.cyan(category.requiresEnvVar)} environment variable`
					);
				}
			}

			// Add all MCPs from the selected category
			for (const mcp of category.mcps) {
				selectedMcps.push(mcp);
			}
			p.log.success(`Added ${category.name}: ${category.mcps.map((m) => m.name).join(", ")}`);
		}
	}

	// Agent Model Configuration (only if agents are being installed)
	let agentModels: AgentModelConfig = { ...DEFAULT_AGENT_MODELS };
	
	// All agent names - we'll ensure all are in the config
	const allAgents = ["build", "coder", "explore", "frontend", "oracle", "plan", "researcher", "reviewer", "scribe"];
	
	// Track global model for when user skips per-agent config
	let globalModelToSet: string | null = null;
	
	if (options.agents) {
		p.log.info(`\n${pc.bold("Agent Model Configuration")}`);
		p.log.info(pc.dim("Press Enter to use suggested model, or type your own."));
		
		const configureModels = await p.confirm({
			message: "Configure per-agent models?",
			initialValue: false,
		});

		if (!p.isCancel(configureModels) && configureModels) {
			// Agent descriptions and suggested models
			const agentPrompts: { name: string; desc: string; defaultModel: string }[] = [
				{ name: "build", desc: "Build agent (default, writes code)", defaultModel: "proxy/claude-sonnet-4-5-thinking" },
				{ name: "coder", desc: "Coder (atomic coding tasks)", defaultModel: "proxy/claude-opus-4-5-thinking" },
				{ name: "frontend", desc: "Frontend (UI/UX specialist)", defaultModel: "proxy/gemini-3-pro-high" },
				{ name: "plan", desc: "Plan (strategic planning)", defaultModel: "proxy/claude-opus-4-5-thinking" },
				{ name: "oracle", desc: "Oracle (architecture, debugging)", defaultModel: "quotio/gpt-5.2-codex" },
				{ name: "reviewer", desc: "Reviewer (code review)", defaultModel: "quotio/gpt-5.2-codex" },
				{ name: "explore", desc: "Explore (codebase search)", defaultModel: "proxy/gemini-3-flash" },
				{ name: "researcher", desc: "Researcher (external docs)", defaultModel: "proxy/gemini-3-flash" },
				{ name: "scribe", desc: "Scribe (documentation)", defaultModel: "proxy/gemini-3-flash" },
			];

			for (const agent of agentPrompts) {
				const model = await p.text({
					message: `${agent.desc}:`,
					placeholder: agent.defaultModel,
					defaultValue: agent.defaultModel, // Enter uses this value
				});
				if (!p.isCancel(model) && model.trim()) {
					agentModels[agent.name] = model.trim();
				}
			}
		} else {
			// User skipped per-agent config - ask for global model
			const globalModel = await p.text({
				message: "Global model for all agents:",
				placeholder: "anthropic/claude-sonnet-4-20250514",
				defaultValue: "anthropic/claude-sonnet-4-20250514",
			});
			
			if (!p.isCancel(globalModel) && globalModel.trim()) {
				globalModelToSet = globalModel.trim();
			}
		}
	}

	// Track if user configured models (for finish page instructions)
	const hasConfiguredModels = Object.values(agentModels).some((m) => m && m.length > 0) || globalModelToSet !== null;

	// Installation
	const s = p.spinner();
	s.start("Installing op1 components...");

	let totalFiles = 0;

	try {
		// Create config directory
		await mkdir(globalConfigDir, { recursive: true });

		// Copy agents
		if (options.agents) {
			const src = join(TEMPLATES_DIR, "agent");
			const dest = join(globalConfigDir, "agent");
			if (await dirExists(src)) {
				totalFiles += await copyDir(src, dest);
			}
		}

		// Copy commands
		if (options.commands) {
			const src = join(TEMPLATES_DIR, "command");
			const dest = join(globalConfigDir, "command");
			if (await dirExists(src)) {
				totalFiles += await copyDir(src, dest);
			}
		}

		// Copy skills
		if (options.skills) {
			const src = join(TEMPLATES_DIR, "skill");
			const dest = join(globalConfigDir, "skill");
			if (await dirExists(src)) {
				totalFiles += await copyDir(src, dest);
			}
		}

		// Merge and write config (always pass original config to preserve provider)
		const originalConfig = configFileResult.data;
		const mergedConfig = mergeConfig(existingJson, originalConfig, selectedMcps, pluginChoices, agentModels, globalModelToSet, allAgents);
		await writeJsonFile(globalConfigFile, mergedConfig);
		totalFiles++;

		s.stop(`Installed ${totalFiles} files`);
	} catch (error) {
		s.stop("Installation failed");
		throw error;
	}

	// Summary
	const summaryLines: string[] = [];
	
	if (configBackupPath) {
		summaryLines.push(`${pc.blue("↩")} Config backup: ${pc.dim(configBackupPath)}`);
	}
	if (options.agents) {
		summaryLines.push(`${pc.green("✓")} Agents installed to ${pc.dim("~/.config/opencode/agent/")}`);
	}
	if (options.commands) {
		summaryLines.push(`${pc.green("✓")} Commands installed to ${pc.dim("~/.config/opencode/command/")}`);
	}
	if (options.skills) {
		summaryLines.push(`${pc.green("✓")} Skills installed to ${pc.dim("~/.config/opencode/skill/")}`);
	}
	if (options.plugins) {
		summaryLines.push(`${pc.green("✓")} Plugins configured in opencode.json`);
	}
	if (selectedMcps.length > 0) {
		summaryLines.push(
			`${pc.green("✓")} MCPs configured: ${selectedMcps.map((m) => pc.cyan(m.name)).join(", ")}`
		);
	}

	p.note(summaryLines.join("\n"), "Installation complete");

	// Show any required env vars (based on selected MCPs)
	const selectedCategoryIds = [...new Set(
		selectedMcps.map((mcp) => 
			MCP_CATEGORIES.find((c) => c.mcps.some((m) => m.id === mcp.id))?.id
		).filter(Boolean)
	)] as string[];
	
	const missingEnvVars = MCP_CATEGORIES
		.filter((c) => selectedCategoryIds.includes(c.id) && c.requiresEnvVar)
		.filter((c) => !process.env[c.requiresEnvVar!])
		.map((c) => c.requiresEnvVar!);

	if (missingEnvVars.length > 0) {
		p.log.warn(
			`\n${pc.yellow("⚠")} Set these environment variables for full functionality:\n` +
			missingEnvVars.map((v) => `  ${pc.cyan(v)}`).join("\n")
		);
	}

	p.outro(`Run ${pc.cyan("opencode")} to start coding with op1!`);
}

export { copyDir, fileExists, mergeConfig, MCP_CATEGORIES };
export type { InstallOptions, PluginChoice, McpDefinition, McpCategory, OpenCodeConfig };
