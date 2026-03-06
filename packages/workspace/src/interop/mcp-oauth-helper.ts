import { homedir } from "../bun-compat.js";
import { resolveMcpPointerIndex } from "./mcp-pointer-resolve.js";
import {
	type JsonConfigFile,
	loadOpencodeConfigFiles,
	loadWarmplaneConfig,
	parseMcp0FromConfig,
	resolveAuthStoreCandidates,
	resolveWarmplaneTemplateString,
	type WarmplaneConfigFile,
} from "./warmplane-config.js";

interface OAuthAuthEntry {
	tokens?: {
		accessToken?: string;
		expiresAt?: number;
	};
	clientInfo?: {
		clientId?: string;
		clientSecret?: string;
	};
	serverUrl?: string;
}

type OAuthAuthStore = Record<string, OAuthAuthEntry>;

interface ServerSource {
	name: string;
	url: string;
	source_config: string;
	managed_by: "direct" | "warmplane";
	warmplane_config_path?: string;
	token_store_key: string;
	has_client_id: boolean;
	has_client_secret: boolean;
}

export interface McpOAuthServerSnapshot {
	name: string;
	url: string;
	source_config: string;
	pointer_source: "pointer" | "legacy";
	pointer_requirement?: "required" | "optional";
	pointer_lifecycle_state?:
		| "idle"
		| "starting"
		| "ready"
		| "degraded"
		| "closed";
	pointer_health_status?: "healthy" | "degraded" | "unavailable";
	pointer_stale: boolean;
	oauth_capable: boolean;
	has_client_id: boolean;
	has_client_secret: boolean;
	auth_status: "authenticated" | "expired" | "not_authenticated";
	recommended_action: string;
	managed_by?: "direct" | "warmplane";
	warmplane_config_path?: string;
	token_store_key?: string;
}

export interface McpOAuthHelperSnapshot {
	generated_at: string;
	config_sources: string[];
	auth_store_path?: string;
	pointer_source: "pointer" | "legacy";
	pointer_issues: McpOAuthServerSnapshot["recommended_action"][];
	servers: McpOAuthServerSnapshot[];
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
	serverUrl?: string,
): "authenticated" | "expired" | "not_authenticated" {
	if (!entry?.tokens?.accessToken) {
		return "not_authenticated";
	}

	if (serverUrl && entry.serverUrl && entry.serverUrl !== serverUrl) {
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

function buildRecommendedAction(input: {
	name: string;
	status: "authenticated" | "expired" | "not_authenticated";
	managedBy: "direct" | "warmplane";
	warmplaneConfigPath?: string;
}): string {
	if (input.managedBy === "warmplane") {
		const configPath = input.warmplaneConfigPath || "<path>";
		if (input.status === "authenticated") {
			return `Authenticated in Warmplane. Optional diagnostics: warmplane auth status --config ${configPath}`;
		}

		if (input.status === "expired") {
			return `Warmplane-managed credentials expired. Re-import or refresh them, then verify with: warmplane auth status --config ${configPath}`;
		}

		return `Import credentials into Warmplane with: warmplane auth import --config ${configPath} --server ${input.name} --access-token-env <ENV>`;
	}

	if (input.status === "authenticated") {
		return `Authenticated. Optional diagnostics: opencode mcp debug ${input.name}`;
	}

	if (input.status === "expired") {
		return `Credentials expired. Run: opencode mcp auth ${input.name}`;
	}

	return `Authenticate this server with: opencode mcp auth ${input.name}`;
}

function isOAuthCapableConfig(config: Record<string, unknown>): boolean {
	if (config.oauth === true) {
		return true;
	}

	if (config.oauth && typeof config.oauth === "object") {
		return true;
	}

	if (config.type === "local") {
		const command = config.command;
		if (Array.isArray(command)) {
			return command.some(
				(token): token is string =>
					typeof token === "string" && token.includes("mcp-remote"),
			);
		}

		if (typeof command === "string") {
			return command.includes("mcp-remote");
		}
	}

	return false;
}

function collectDirectServers(
	mergedMcp: Record<string, Record<string, unknown>>,
): Map<string, ServerSource> {
	const servers = new Map<string, ServerSource>();

	for (const [name, config] of Object.entries(mergedMcp)) {
		if (name === "mcp0") continue;
		if (!isOAuthCapableConfig(config)) continue;
		const oauthConfig =
			config.oauth && typeof config.oauth === "object"
				? (config.oauth as Record<string, unknown>)
				: null;

		servers.set(name, {
			name,
			url: typeof config.url === "string" ? config.url : "",
			source_config:
				typeof config.source_config === "string"
					? config.source_config
					: "unknown",
			managed_by: "direct",
			token_store_key: name,
			has_client_id:
				oauthConfig !== null && typeof oauthConfig.clientId === "string",
			has_client_secret:
				oauthConfig !== null && typeof oauthConfig.clientSecret === "string",
		});
	}

	return servers;
}

function collectWarmplaneServers(
	warmplaneConfig: WarmplaneConfigFile | null,
): Map<string, ServerSource> {
	const servers = new Map<string, ServerSource>();
	if (!warmplaneConfig) return servers;

	for (const [name, server] of Object.entries(
		warmplaneConfig.data.mcpServers || {},
	)) {
		const auth = server.auth;
		if (!auth || typeof auth !== "object" || auth.type !== "oauth") continue;
		const tokenStoreKey =
			typeof auth.tokenStoreKey === "string" && auth.tokenStoreKey.length > 0
				? auth.tokenStoreKey
				: name;

		servers.set(name, {
			name,
			url:
				typeof server.url === "string"
					? resolveWarmplaneTemplateString(server.url)
					: "",
			source_config: warmplaneConfig.path,
			managed_by: "warmplane",
			warmplane_config_path: warmplaneConfig.path,
			token_store_key: tokenStoreKey,
			has_client_id: typeof auth.clientId === "string",
			has_client_secret:
				typeof auth.clientSecret === "string" ||
				typeof auth.clientSecretEnv === "string",
		});
	}

	return servers;
}

export async function buildMcpOAuthHelperSnapshot(input: {
	directory: string;
	homeDirectory?: string;
	server?: string;
}): Promise<McpOAuthHelperSnapshot> {
	const homeDirectory = input.homeDirectory ?? homedir();
	const configFiles = await loadOpencodeConfigFiles({
		directory: input.directory,
		homeDirectory,
	});
	const mergedMcp = mergeMcpConfigs(configFiles);
	const effectiveMcp0Server = configFiles
		.flatMap((file) => parseMcp0FromConfig(file))
		.at(-1);
	const warmplaneConfig = await loadWarmplaneConfig(
		effectiveMcp0Server?.config_path,
	);
	const pointerResolution = await resolveMcpPointerIndex({ homeDirectory });
	const pointerServers = new Map(
		(pointerResolution.index?.servers ?? []).map((server) => [
			server.id,
			server,
		]),
	);
	const authStoreResult = await readAuthStore(
		resolveAuthStoreCandidates({
			homeDirectory,
			warmplaneConfig,
		}),
	);

	const directServers = collectDirectServers(mergedMcp);
	const warmplaneServers = collectWarmplaneServers(warmplaneConfig);
	const combinedServers = new Map<string, ServerSource>([
		...directServers,
		...warmplaneServers,
	]);

	for (const [name, pointerServer] of pointerServers) {
		if (combinedServers.has(name)) continue;
		if (pointerServer.auth.oauth_capable !== true) continue;
		combinedServers.set(name, {
			name,
			url: "",
			source_config: pointerServer.source_config,
			managed_by: warmplaneServers.has(name) ? "warmplane" : "direct",
			token_store_key: name,
			has_client_id: pointerServer.auth.has_client_id,
			has_client_secret: pointerServer.auth.has_client_secret,
		});
	}

	const serverEntries = [...combinedServers.entries()]
		.filter(([name]) => !input.server || name === input.server)
		.sort((a, b) => a[0].localeCompare(b[0]));

	const servers: McpOAuthServerSnapshot[] = serverEntries.map(([, source]) => {
		const pointerServer = pointerServers.get(source.name);
		const storeEntry = authStoreResult.store[source.token_store_key];
		const status = deriveAuthStatus(storeEntry, source.url || undefined);

		return {
			name: source.name,
			url: source.url,
			source_config: source.source_config,
			pointer_source: pointerServer ? "pointer" : "legacy",
			pointer_requirement: pointerServer?.requirement,
			pointer_lifecycle_state: pointerServer?.lifecycle_state,
			pointer_health_status: pointerServer?.health_status,
			pointer_stale:
				pointerServer?.capability?.expires_at !== undefined &&
				Date.parse(pointerServer.capability.expires_at) <= Date.now(),
			oauth_capable: true,
			has_client_id:
				source.has_client_id ||
				(storeEntry?.clientInfo?.clientId
					? storeEntry.clientInfo.clientId.length > 0
					: false),
			has_client_secret:
				source.has_client_secret ||
				(storeEntry?.clientInfo?.clientSecret
					? storeEntry.clientInfo.clientSecret.length > 0
					: false),
			auth_status: status,
			recommended_action: buildRecommendedAction({
				name: source.name,
				status,
				managedBy: source.managed_by,
				warmplaneConfigPath: source.warmplane_config_path,
			}),
			managed_by: source.managed_by,
			warmplane_config_path: source.warmplane_config_path,
			token_store_key: source.token_store_key,
		};
	});

	return {
		generated_at: new Date().toISOString(),
		config_sources: configFiles.map((entry) => entry.path),
		auth_store_path: authStoreResult.path,
		pointer_source: pointerResolution.source,
		pointer_issues: pointerResolution.issues.map((issue) => issue.message),
		servers,
	};
}
