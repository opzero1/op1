import { homedir } from "../bun-compat.js";
import {
	buildMcpOAuthHelperSnapshot,
	type McpOAuthServerSnapshot,
} from "./mcp-oauth-helper.js";
import {
	loadOpencodeConfigFiles,
	loadWarmplaneConfig,
	parseMcp0FromConfig,
	resolveAuthStoreCandidates,
} from "./warmplane-config.js";

type ResolveCommandPath = (command: string) => Promise<string | null>;

interface Mcp0OAuthUpstreamHealth {
	name: string;
	url: string;
	auth_status: McpOAuthServerSnapshot["auth_status"];
	has_client_id: boolean;
	has_client_secret: boolean;
	token_store_key?: string;
	recommended_action: string;
}

interface Mcp0ServerHealth {
	name: string;
	source_config: string;
	command: string[];
	binary_found: boolean;
	binary_path?: string;
	has_config_arg: boolean;
	config_path?: string;
	warmplane_config_found: boolean;
	upstream_count?: number;
	oauth_upstream_count?: number;
	oauth_ready_count?: number;
	oauth_not_ready_count?: number;
	downstream_oauth_servers?: Mcp0OAuthUpstreamHealth[];
	auth_store_path?: string;
	recommended_action: string;
}

export interface Mcp0HealthSnapshot {
	generated_at: string;
	found: boolean;
	config_sources: string[];
	servers: Mcp0ServerHealth[];
	issues: string[];
}

async function resolveExistingAuthStorePath(
	candidates: string[],
): Promise<string | undefined> {
	for (const path of candidates) {
		if (await Bun.file(path).exists()) return path;
	}
	return candidates[0];
}

function isAbsolutePath(input: string): boolean {
	if (input.startsWith("/")) return true;
	return /^[A-Za-z]:[\\/]/.test(input);
}

async function defaultResolveCommandPath(
	command: string,
): Promise<string | null> {
	if (command.length === 0) return null;
	if (isAbsolutePath(command)) {
		return (await Bun.file(command).exists()) ? command : null;
	}

	return Bun.which(command) ?? null;
}

function buildRecommendedAction(input: {
	binary: string | undefined;
	binaryPath: string | null;
	server: Mcp0ServerHealth;
	oauthNotReady: Mcp0OAuthUpstreamHealth[];
}): string {
	if (!input.binary) {
		return "mcp0 command is empty. Reinstall or set a valid warmplane command in MCP config.";
	}

	if (!input.binaryPath) {
		return `Warmplane binary '${input.binary}' is not available on PATH. Install warmplane or update the configured command.`;
	}

	if (!input.server.has_config_arg) {
		return 'Add an explicit config path to mcp0 command args: ["warmplane","mcp-server","--config","<path>"]';
	}

	if (!input.server.warmplane_config_found) {
		return "mcp0 config path is set but the Warmplane config file is missing or invalid. Reinstall or run: warmplane validate-config --config <path>";
	}

	if (input.oauthNotReady.length > 0) {
		const names = input.oauthNotReady.map((entry) => entry.name).join(", ");
		return `Warmplane config loaded, but downstream OAuth is not ready for: ${names}. Run: warmplane auth status --config ${input.server.config_path}`;
	}

	return `Warmplane config loaded with ${String(input.server.upstream_count ?? 0)} upstream server(s). Validate with: warmplane validate-config --config ${input.server.config_path}`;
}

export async function buildMcp0HealthSnapshot(input: {
	directory: string;
	homeDirectory?: string;
	resolveCommandPath?: ResolveCommandPath;
}): Promise<Mcp0HealthSnapshot> {
	const homeDirectory = input.homeDirectory ?? homedir();
	const resolveCommandPath =
		input.resolveCommandPath ?? defaultResolveCommandPath;
	const files = await loadOpencodeConfigFiles({
		directory: input.directory,
		homeDirectory,
	});
	const rawServers = files.flatMap((file) => parseMcp0FromConfig(file));
	const oauthSnapshot = await buildMcpOAuthHelperSnapshot({
		directory: input.directory,
		homeDirectory,
	});
	const servers = await Promise.all(
		rawServers.map(async (server) => {
			const binary = server.command[0];
			const binaryPath = binary ? await resolveCommandPath(binary) : null;
			const warmplaneConfig = await loadWarmplaneConfig(server.config_path);
			const upstreams = warmplaneConfig?.data.mcpServers || {};
			const upstreamEntries = Object.entries(upstreams);
			const downstreamOAuthServers = oauthSnapshot.servers
				.filter(
					(entry) =>
						entry.managed_by === "warmplane" &&
						entry.warmplane_config_path === warmplaneConfig?.path,
				)
				.map<Mcp0OAuthUpstreamHealth>((entry) => ({
					name: entry.name,
					url: entry.url,
					auth_status: entry.auth_status,
					has_client_id: entry.has_client_id,
					has_client_secret: entry.has_client_secret,
					token_store_key: entry.token_store_key,
					recommended_action: entry.recommended_action,
				}));
			const oauthNotReady = downstreamOAuthServers.filter(
				(entry) => entry.auth_status !== "authenticated",
			);
			const oauthUpstreamCount = upstreamEntries.filter(([, config]) => {
				const auth = config.auth;
				return auth && typeof auth === "object" && auth.type === "oauth";
			}).length;
			const authStorePath = warmplaneConfig
				? await resolveExistingAuthStorePath(
						resolveAuthStoreCandidates({ homeDirectory, warmplaneConfig }),
					)
				: undefined;

			const health: Mcp0ServerHealth = {
				...server,
				binary_found: binaryPath !== null,
				binary_path: binaryPath ?? undefined,
				warmplane_config_found: warmplaneConfig !== null,
				upstream_count: warmplaneConfig ? upstreamEntries.length : undefined,
				oauth_upstream_count: warmplaneConfig ? oauthUpstreamCount : undefined,
				oauth_ready_count: downstreamOAuthServers.filter(
					(entry) => entry.auth_status === "authenticated",
				).length,
				oauth_not_ready_count: oauthNotReady.length,
				downstream_oauth_servers: downstreamOAuthServers,
				auth_store_path: authStorePath,
				recommended_action: "",
			};

			health.recommended_action = buildRecommendedAction({
				binary,
				binaryPath,
				server: health,
				oauthNotReady,
			});

			return {
				...health,
			};
		}),
	);
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

	if (servers.some((server) => !server.binary_found)) {
		issues.push(
			"Warmplane binary is not available for at least one mcp0 entry. Install warmplane or fix the configured command path.",
		);
	}

	if (
		servers.some(
			(server) => server.has_config_arg && !server.warmplane_config_found,
		)
	) {
		issues.push(
			"mcp0 config path is set, but the referenced Warmplane config file is missing or invalid.",
		);
	}

	for (const server of servers) {
		const notReady =
			server.downstream_oauth_servers?.filter(
				(entry) => entry.auth_status !== "authenticated",
			) || [];
		if (notReady.length === 0) continue;

		issues.push(
			`Warmplane downstream OAuth is not ready for ${notReady.map((entry) => entry.name).join(", ")}. Run: warmplane auth status --config ${server.config_path}`,
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
