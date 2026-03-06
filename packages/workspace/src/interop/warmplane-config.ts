import { homedir, join } from "../bun-compat.js";

export interface JsonConfigFile {
	path: string;
	data: Record<string, unknown>;
}

export interface Mcp0ConfigEntry {
	name: string;
	source_config: string;
	command: string[];
	has_config_arg: boolean;
	config_path?: string;
}

export interface WarmplaneServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	auth?: Record<string, unknown>;
}

export interface WarmplaneConfigFile {
	path: string;
	data: {
		authStorePath?: string;
		mcpServers?: Record<string, WarmplaneServerConfig>;
	};
}

export function stripJsonc(content: string): string {
	return content.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

export function resolveWarmplaneTemplateString(input: string): string {
	let out = "";
	let rest = input;

	while (rest.length > 0) {
		const brace = rest.indexOf("{env:");
		const dollar = rest.indexOf("${env:");
		const next =
			brace >= 0 && dollar >= 0
				? brace <= dollar
					? [brace, 5]
					: [dollar, 6]
				: brace >= 0
					? [brace, 5]
					: dollar >= 0
						? [dollar, 6]
						: null;
		if (!next) {
			out += rest;
			break;
		}

		const [index, prefixLength] = next;
		out += rest.slice(0, index);
		const after = rest.slice(index + prefixLength);
		const end = after.indexOf("}");
		if (end < 0) {
			out += rest.slice(index);
			break;
		}

		const name = after.slice(0, end).trim();
		const value = Bun.env[name];
		if (!name || typeof value !== "string") {
			out += rest.slice(index, index + prefixLength + end + 1);
			rest = after.slice(end + 1);
			continue;
		}

		out += value;
		rest = after.slice(end + 1);
	}

	return out;
}

export async function readJsonConfig(
	path: string,
): Promise<JsonConfigFile | null> {
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

export function resolveOpencodeConfigCandidates(
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

export async function loadOpencodeConfigFiles(input: {
	directory: string;
	homeDirectory?: string;
}): Promise<JsonConfigFile[]> {
	const homeDirectory = input.homeDirectory ?? homedir();
	return (
		await Promise.all(
			resolveOpencodeConfigCandidates(input.directory, homeDirectory).map(
				(path) => readJsonConfig(path),
			),
		)
	).filter((entry): entry is JsonConfigFile => entry !== null);
}

export function parseMcp0FromConfig(file: JsonConfigFile): Mcp0ConfigEntry[] {
	const mcpSection = file.data.mcp;
	if (!mcpSection || typeof mcpSection !== "object") return [];

	const servers: Mcp0ConfigEntry[] = [];
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
		});
	}

	return servers;
}

export async function loadWarmplaneConfig(
	configPath?: string,
): Promise<WarmplaneConfigFile | null> {
	if (!configPath) return null;
	const file = await readJsonConfig(configPath);
	if (!file) return null;
	return {
		path: file.path,
		data: {
			authStorePath:
				typeof file.data.authStorePath === "string"
					? file.data.authStorePath
					: undefined,
			mcpServers:
				file.data.mcpServers && typeof file.data.mcpServers === "object"
					? (file.data.mcpServers as Record<string, WarmplaneServerConfig>)
					: undefined,
		},
	};
}

export function resolveAuthStoreCandidates(input: {
	homeDirectory: string;
	warmplaneConfig?: WarmplaneConfigFile | null;
}): string[] {
	const explicit = input.warmplaneConfig?.data.authStorePath;
	const defaults = [
		join(input.homeDirectory, ".local", "share", "opencode", "mcp-auth.json"),
		join(input.homeDirectory, ".config", "opencode", "mcp-auth.json"),
	];
	if (!explicit) return defaults;
	return [explicit];
}
