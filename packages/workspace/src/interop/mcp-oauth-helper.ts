import { homedir, join } from "../bun-compat.js";

interface JsonConfigFile {
	path: string;
	data: Record<string, unknown>;
}

interface OAuthAuthEntry {
	tokens?: {
		accessToken?: string;
		expiresAt?: number;
	};
}

type OAuthAuthStore = Record<string, OAuthAuthEntry>;

export interface McpOAuthServerSnapshot {
	name: string;
	url: string;
	source_config: string;
	oauth_capable: boolean;
	has_client_id: boolean;
	has_client_secret: boolean;
	auth_status: "authenticated" | "expired" | "not_authenticated";
	recommended_action: string;
}

export interface McpOAuthHelperSnapshot {
	generated_at: string;
	config_sources: string[];
	auth_store_path?: string;
	servers: McpOAuthServerSnapshot[];
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

async function readAuthStore(paths: string[]): Promise<{
	path?: string;
	store: OAuthAuthStore;
}> {
	for (const path of paths) {
		const file = Bun.file(path);
		if (!(await file.exists())) continue;

		try {
			const parsed = (await file.json()) as unknown;
			if (!parsed || typeof parsed !== "object") {
				return { path, store: {} };
			}

			return {
				path,
				store: parsed as OAuthAuthStore,
			};
		} catch {
			return { path, store: {} };
		}
	}

	return { store: {} };
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

function resolveAuthStoreCandidates(homeDirectory: string): string[] {
	return [
		join(homeDirectory, ".local", "share", "opencode", "mcp-auth.json"),
		join(homeDirectory, ".config", "opencode", "mcp-auth.json"),
	];
}

function mergeMcpConfigs(
	files: JsonConfigFile[],
): Record<string, Record<string, unknown>> {
	const merged: Record<string, Record<string, unknown>> = {};

	for (const file of files) {
		const mcpSection = file.data.mcp;
		if (!mcpSection || typeof mcpSection !== "object") continue;

		for (const [name, rawConfig] of Object.entries(
			mcpSection as Record<string, unknown>,
		)) {
			if (!rawConfig || typeof rawConfig !== "object") continue;
			merged[name] = {
				...(merged[name] ?? {}),
				...(rawConfig as Record<string, unknown>),
				source_config: file.path,
			};
		}
	}

	return merged;
}

function deriveAuthStatus(
	entry?: OAuthAuthEntry,
): "authenticated" | "expired" | "not_authenticated" {
	if (!entry?.tokens?.accessToken) {
		return "not_authenticated";
	}

	if (
		typeof entry.tokens.expiresAt === "number" &&
		entry.tokens.expiresAt < Date.now() / 1000
	) {
		return "expired";
	}

	return "authenticated";
}

function buildRecommendedAction(name: string, status: string): string {
	if (status === "authenticated") {
		return `Authenticated. Optional diagnostics: opencode mcp debug ${name}`;
	}

	if (status === "expired") {
		return `Credentials expired. Run: opencode mcp auth ${name}`;
	}

	return `Authenticate this server with: opencode mcp auth ${name}`;
}

export async function buildMcpOAuthHelperSnapshot(input: {
	directory: string;
	homeDirectory?: string;
	server?: string;
}): Promise<McpOAuthHelperSnapshot> {
	const homeDirectory = input.homeDirectory ?? homedir();
	const configCandidates = resolveConfigCandidates(
		input.directory,
		homeDirectory,
	);
	const configFiles = (
		await Promise.all(configCandidates.map((path) => readJsonConfig(path)))
	).filter((entry): entry is JsonConfigFile => entry !== null);

	const mergedMcp = mergeMcpConfigs(configFiles);
	const authStoreResult = await readAuthStore(
		resolveAuthStoreCandidates(homeDirectory),
	);

	const serverEntries = Object.entries(mergedMcp)
		.filter(([, config]) => config.type === "remote")
		.filter(([, config]) => {
			if (config.oauth === true) return true;
			return Boolean(config.oauth && typeof config.oauth === "object");
		})
		.filter(([name]) => !input.server || name === input.server)
		.sort((a, b) => a[0].localeCompare(b[0]));

	const servers: McpOAuthServerSnapshot[] = serverEntries.map(
		([name, config]) => {
			const oauthConfig =
				config.oauth && typeof config.oauth === "object"
					? (config.oauth as Record<string, unknown>)
					: null;
			const status = deriveAuthStatus(authStoreResult.store[name]);

			return {
				name,
				url: typeof config.url === "string" ? config.url : "",
				source_config:
					typeof config.source_config === "string"
						? config.source_config
						: "unknown",
				oauth_capable: true,
				has_client_id:
					oauthConfig !== null && typeof oauthConfig.clientId === "string",
				has_client_secret:
					oauthConfig !== null && typeof oauthConfig.clientSecret === "string",
				auth_status: status,
				recommended_action: buildRecommendedAction(name, status),
			};
		},
	);

	return {
		generated_at: new Date().toISOString(),
		config_sources: configFiles.map((entry) => entry.path),
		auth_store_path: authStoreResult.path,
		servers,
	};
}
