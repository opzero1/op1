/**
 * LSP Configuration
 *
 * Server discovery, configuration loading, and installation checking.
 */

import {
	currentWorkingDirectory,
	homeDirectory,
	joinPath,
	resolvePath,
	runtimePlatform,
} from "./bun-utils";
import { BUILTIN_SERVERS, EXT_TO_LANG, LSP_INSTALL_HINTS } from "./constants";
import {
	canAutoInstallTerraformLs,
	ensureTerraformLsBinary,
} from "./terraform-ls";
import { canAutoInstallTexlab, ensureTexlabBinary } from "./texlab";
import { canAutoInstallTinymist, ensureTinymistBinary } from "./tinymist";
import type { ResolvedServer, ServerLookupResult } from "./types";

interface LspEntry {
	disabled?: boolean;
	command?: string[];
	extensions?: string[];
	priority?: number;
	env?: Record<string, string>;
	initialization?: Record<string, unknown>;
}

interface ConfigJson {
	lsp?: Record<string, LspEntry>;
}

type ConfigSource = "project" | "user" | "opencode";

interface ServerWithSource extends ResolvedServer {
	source: ConfigSource;
}

async function pathExists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

async function loadJsonFile<T>(path: string): Promise<T | null> {
	if (!(await pathExists(path))) return null;
	try {
		return (await Bun.file(path).json()) as T;
	} catch {
		return null;
	}
}

async function resolveInstalledCommand(
	command: string[],
): Promise<string | null> {
	if (command.length === 0) return null;

	const cmd = command[0];

	if (cmd.includes("/") || cmd.includes("\\")) {
		const absolute = resolvePath(cmd);
		if (await pathExists(absolute)) return absolute;
	}

	const fromPath = Bun.which(cmd);
	if (fromPath) return fromPath;

	const isWindows = runtimePlatform() === "win32";

	let exts = [""];
	if (isWindows) {
		const pathExt = Bun.env.PATHEXT || "";
		if (pathExt) {
			const systemExts = pathExt.split(";").filter(Boolean);
			exts = [
				...new Set([...exts, ...systemExts, ".exe", ".cmd", ".bat", ".ps1"]),
			];
		} else {
			exts = ["", ".exe", ".cmd", ".bat", ".ps1"];
		}
	}

	const cwd = currentWorkingDirectory();
	const home = homeDirectory();
	const additionalBases = [
		joinPath(cwd, "node_modules", ".bin"),
		joinPath(home, ".config", "opencode", "bin"),
		joinPath(home, ".config", "opencode", "node_modules", ".bin"),
	];

	for (const base of additionalBases) {
		for (const suffix of exts) {
			const candidate = joinPath(base, cmd + suffix);
			if (await pathExists(candidate)) {
				return candidate;
			}
		}
	}

	if (cmd === "bun" || cmd === "node") {
		return cmd;
	}

	return null;
}

const AUTO_LSP_PACKAGES: Record<string, string> = {
	"typescript-language-server": "typescript-language-server",
	"vue-language-server": "@vue/language-server",
	"vscode-eslint-language-server": "vscode-langservers-extracted",
	oxlint: "oxlint",
	biome: "@biomejs/biome",
	svelteserver: "svelte-language-server",
	"astro-ls": "@astrojs/language-server",
	"yaml-language-server": "yaml-language-server",
	"bash-language-server": "bash-language-server",
	intelephense: "intelephense",
	"docker-langserver": "dockerfile-language-server-nodejs",
	prisma: "prisma",
};

async function resolveAutoCommand(
	command: string[],
	allowInstall = true,
): Promise<string[] | null> {
	if (command.length === 0) return null;

	const [cmd, ...args] = command;
	const pkg = AUTO_LSP_PACKAGES[cmd];
	if (pkg) {
		const bun = Bun.which("bun") || "bun";
		return [bun, "x", "--package", pkg, cmd, ...args];
	}

	if (cmd !== "terraform-ls") {
		if (!allowInstall) {
			if (cmd === "texlab" && canAutoInstallTexlab()) return command;
			if (cmd === "tinymist" && canAutoInstallTinymist()) return command;
			return null;
		}

		if (cmd === "texlab") {
			const binary = await ensureTexlabBinary();
			if (!binary) return null;
			return [binary, ...args];
		}

		if (cmd === "tinymist") {
			const binary = await ensureTinymistBinary();
			if (!binary) return null;
			return [binary, ...args];
		}

		return null;
	}

	if (!allowInstall) {
		if (!canAutoInstallTerraformLs()) return null;
		return command;
	}

	const binary = await ensureTerraformLsBinary();
	if (!binary) return null;

	return [binary, ...args];
}

function getConfigPaths(): { project: string; user: string; opencode: string } {
	const cwd = currentWorkingDirectory();
	const home = homeDirectory();
	return {
		project: joinPath(cwd, ".opencode", "op1-lsp.json"),
		user: joinPath(home, ".config", "opencode", "op1-lsp.json"),
		opencode: joinPath(home, ".config", "opencode", "opencode.json"),
	};
}

async function loadAllConfigs(): Promise<Map<ConfigSource, ConfigJson>> {
	const paths = getConfigPaths();
	const configs = new Map<ConfigSource, ConfigJson>();

	const project = await loadJsonFile<ConfigJson>(paths.project);
	if (project) configs.set("project", project);

	const user = await loadJsonFile<ConfigJson>(paths.user);
	if (user) configs.set("user", user);

	const opencode = await loadJsonFile<ConfigJson>(paths.opencode);
	if (opencode) configs.set("opencode", opencode);

	return configs;
}

async function getMergedServers(): Promise<ServerWithSource[]> {
	const configs = await loadAllConfigs();
	const servers: ServerWithSource[] = [];
	const disabled = new Set<string>();
	const seen = new Set<string>();

	const sources: ConfigSource[] = ["project", "user", "opencode"];

	for (const source of sources) {
		const config = configs.get(source);
		if (!config?.lsp) continue;

		for (const [id, entry] of Object.entries(config.lsp)) {
			if (entry.disabled) {
				disabled.add(id);
				continue;
			}

			if (seen.has(id)) continue;
			if (!entry.command || !entry.extensions) continue;

			servers.push({
				config: {
					id,
					command: entry.command,
					extensions: entry.extensions,
					priority: entry.priority ?? 0,
					env: entry.env,
					initializationOptions: entry.initialization,
				},
				languageId: "",
				source,
			});
			seen.add(id);
		}
	}

	for (const [id, config] of Object.entries(BUILTIN_SERVERS)) {
		if (disabled.has(id) || seen.has(id)) continue;

		servers.push({
			config: {
				id,
				command: config.command,
				extensions: config.extensions,
				priority: -100,
			},
			languageId: "",
			source: "opencode",
		});
	}

	return servers.sort((a, b) => {
		if (a.source !== b.source) {
			const order: Record<ConfigSource, number> = {
				project: 0,
				user: 1,
				opencode: 2,
			};
			return order[a.source] - order[b.source];
		}
		return (b.config.priority ?? 0) - (a.config.priority ?? 0);
	});
}

export async function findServerForExtension(
	ext: string,
): Promise<ServerLookupResult> {
	const servers = await getMergedServers();

	for (const server of servers) {
		if (server.config.extensions.includes(ext)) {
			const resolvedCommand = await resolveInstalledCommand(
				server.config.command,
			);
			const command = resolvedCommand
				? [resolvedCommand, ...server.config.command.slice(1)]
				: await resolveAutoCommand(server.config.command);
			if (!command) continue;

			return {
				status: "found",
				server: {
					config: {
						...server.config,
						command,
					},
					languageId: getLanguageId(ext),
				},
			};
		}
	}

	for (const server of servers) {
		if (server.config.extensions.includes(ext)) {
			const installHint =
				LSP_INSTALL_HINTS[server.config.id] ||
				`Install '${server.config.command[0]}' and ensure it's in your PATH`;
			return {
				status: "not_installed",
				server: server.config,
				installHint,
			};
		}
	}

	return {
		status: "not_configured",
		extension: ext,
	};
}

export function getLanguageId(ext: string): string {
	return EXT_TO_LANG[ext] || "plaintext";
}

export async function isServerInstalled(command: string[]): Promise<boolean> {
	return (
		(await resolveInstalledCommand(command)) !== null ||
		(await resolveAutoCommand(command, false)) !== null
	);
}

export async function getAllServers(): Promise<
	Array<{
		id: string;
		installed: boolean;
		extensions: string[];
		disabled: boolean;
		source: string;
		priority: number;
	}>
> {
	const configs = await loadAllConfigs();
	const servers = await getMergedServers();
	const disabled = new Set<string>();

	for (const config of configs.values()) {
		if (!config.lsp) continue;
		for (const [id, entry] of Object.entries(config.lsp)) {
			if (entry.disabled) disabled.add(id);
		}
	}

	const result: Array<{
		id: string;
		installed: boolean;
		extensions: string[];
		disabled: boolean;
		source: string;
		priority: number;
	}> = [];

	const seen = new Set<string>();

	for (const server of servers) {
		if (seen.has(server.config.id)) continue;
		result.push({
			id: server.config.id,
			installed: await isServerInstalled(server.config.command),
			extensions: server.config.extensions,
			disabled: false,
			source: server.source,
			priority: server.config.priority ?? 0,
		});
		seen.add(server.config.id);
	}

	for (const id of disabled) {
		if (seen.has(id)) continue;
		const builtin = BUILTIN_SERVERS[id];
		result.push({
			id,
			installed: builtin ? await isServerInstalled(builtin.command) : false,
			extensions: builtin?.extensions || [],
			disabled: true,
			source: "disabled",
			priority: 0,
		});
	}

	return result;
}
