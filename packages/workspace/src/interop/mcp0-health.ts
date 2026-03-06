import { homedir, join } from "../bun-compat.js";

interface JsonConfigFile {
	path: string;
	data: Record<string, unknown>;
}

interface Mcp0ServerHealth {
	name: string;
	source_config: string;
	command: string[];
	has_config_arg: boolean;
	config_path?: string;
	recommended_action: string;
}

export interface Mcp0HealthSnapshot {
	generated_at: string;
	found: boolean;
	config_sources: string[];
	servers: Mcp0ServerHealth[];
	issues: string[];
}

function stripJsonc(content: string): string {
	return content.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

async function readJsonConfig(path: string): Promise<JsonConfigFile | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;

	try {
		const text = await file.text();
		const parsed = JSON.parse(stripJsonc(text)) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		return {
			path,
			data: parsed as Record<string, unknown>,
		};
	} catch {
		return null;
	}
}

function resolveConfigCandidates(
	directory: string,
	homeDirectory: string,
): string[] {
	return [
		join(homeDirectory, ".config", "opencode", "opencode.json"),
		join(homeDirectory, ".config", "opencode", "opencode.jsonc"),
		join(directory, "opencode.json"),
		join(directory, "opencode.jsonc"),
		join(directory, ".opencode", "opencode.json"),
		join(directory, ".opencode", "opencode.jsonc"),
	];
}

function parseMcp0FromConfig(file: JsonConfigFile): Mcp0ServerHealth[] {
	const mcpSection = file.data.mcp;
	if (!mcpSection || typeof mcpSection !== "object") return [];

	const servers: Mcp0ServerHealth[] = [];
	for (const [name, rawConfig] of Object.entries(
		mcpSection as Record<string, unknown>,
	)) {
		if (name !== "mcp0") continue;
		if (!rawConfig || typeof rawConfig !== "object") continue;

		const config = rawConfig as Record<string, unknown>;
		const command = Array.isArray(config.command)
			? config.command.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
			: [];

		const configFlagIndex = command.indexOf("--config");
		const configPath =
			configFlagIndex >= 0 ? command[configFlagIndex + 1] : undefined;
		const hasConfigArg =
			typeof configPath === "string" && configPath.length > 0;

		servers.push({
			name,
			source_config: file.path,
			command,
			has_config_arg: hasConfigArg,
			config_path: hasConfigArg ? configPath : undefined,
			recommended_action: hasConfigArg
				? "mcp0 config path is set. Validate with: warmplane validate-config --config <path>"
				: 'Add an explicit config path to mcp0 command args: ["warmplane","mcp-server","--config","<path>"]',
		});
	}

	return servers;
}

export async function buildMcp0HealthSnapshot(input: {
	directory: string;
	homeDirectory?: string;
}): Promise<Mcp0HealthSnapshot> {
	const homeDirectory = input.homeDirectory ?? homedir();
	const candidates = resolveConfigCandidates(input.directory, homeDirectory);
	const files = (
		await Promise.all(candidates.map((path) => readJsonConfig(path)))
	).filter((entry): entry is JsonConfigFile => entry !== null);

	const servers = files.flatMap((file) => parseMcp0FromConfig(file));
	const issues: string[] = [];

	if (servers.length === 0) {
		issues.push(
			"No mcp0 server found in MCP config. Enable mcp0 in installer or add mcp.mcp0 manually.",
		);
	}

	if (servers.some((server) => !server.has_config_arg)) {
		issues.push(
			"mcp0 command is missing --config path. Startup may be nondeterministic across working directories.",
		);
	}

	return {
		generated_at: new Date().toISOString(),
		found: servers.length > 0,
		config_sources: files.map((file) => file.path),
		servers,
		issues,
	};
}
