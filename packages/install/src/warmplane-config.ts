type SourceMcpConfig = {
	type: "local" | "remote";
	command?: string[];
	url?: string;
	protocolVersion?: string;
	allowStateless?: boolean;
	headers?: Record<string, string>;
	environment?: Record<string, string>;
};

type SourceMcpDefinition = {
	id: string;
	name: string;
	description: string;
	toolPattern: string;
	agentAccess: string[];
	required?: boolean;
	oauthCapable?: boolean;
	oauthConfig?: WarmplaneOAuthConfigInput;
	config: SourceMcpConfig;
};

export type WarmplaneAuthConfig =
	| {
			type: "bearer";
			token?: string;
			tokenEnv?: string;
	  }
	| {
			type: "basic";
			username: string;
			password?: string;
			passwordEnv?: string;
	  }
	| {
			type: "oauth";
			clientId?: string;
			clientName?: string;
			clientSecret?: string;
			clientSecretEnv?: string;
			redirectUri?: string;
			scope?: string;
			tokenStoreKey?: string;
			authorizationServer?: string;
			resourceMetadataUrl?: string;
			authorizationEndpoint?: string;
			tokenEndpoint?: string;
			registrationEndpoint?: string;
			codeChallengeMethodsSupported?: string[];
	  };

type WarmplaneOAuthConfigInput = Omit<
	Extract<WarmplaneAuthConfig, { type: "oauth" }>,
	"type" | "tokenStoreKey"
>;

export type WarmplanePointerAuthStatus =
	| "authenticated"
	| "expired"
	| "not_authenticated"
	| "unknown";

export interface WarmplanePointerAuthMetadata {
	authStatus: WarmplanePointerAuthStatus;
	hasClientId: boolean;
	hasClientSecret: boolean;
	lastErrorCode?: "auth_missing" | "auth_expired";
}

interface WarmplaneAuthStoreEntry {
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

export interface WarmplaneServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	protocolVersion?: string;
	allowStateless?: boolean;
	headers?: Record<string, string>;
	auth?: WarmplaneAuthConfig;
}

export interface WarmplaneConfig {
	port?: number;
	toolTimeoutMs?: number;
	authStorePath?: string;
	capabilityAliases: Record<string, string>;
	resourceAliases: Record<string, string>;
	promptAliases: Record<string, string>;
	policy: {
		allow: string[];
		deny: string[];
		redactKeys: string[];
	};
	mcpServers: Record<string, WarmplaneServerConfig>;
}

const DEFAULT_REDACT_KEYS = [
	"token",
	"accessToken",
	"refreshToken",
	"clientSecret",
	"authorization",
	"api_key",
	"api-key",
	"password",
];

function toPosixPath(input: string): string {
	return input.replace(/\\+/g, "/");
}

function isAbsolutePath(input: string): boolean {
	if (input.startsWith("/")) return true;
	return /^[A-Za-z]:\//.test(input);
}

function joinPath(...parts: string[]): string {
	const normalized = parts
		.filter((part) => part.length > 0)
		.map((part) => toPosixPath(part));

	if (normalized.length === 0) return "";

	let result = normalized[0] ?? "";
	for (let index = 1; index < normalized.length; index += 1) {
		const part = normalized[index];
		if (!part) continue;
		if (isAbsolutePath(part)) {
			result = part;
			continue;
		}
		const left = result.replace(/\/+$/, "");
		const right = part.replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return result;
}

function parseEnvTemplate(value: string): string | null {
	const match = value.match(/^\{env:([^}]+)\}$/);
	return match?.[1]?.trim() || null;
}

function hasEnvTemplate(value: string): boolean {
	return /\$?\{env:[^}]+\}/.test(value);
}

function translateAuthorizationHeader(
	value: string,
): WarmplaneAuthConfig | null {
	const bearerEnv = value.match(/^Bearer\s+\{env:([^}]+)\}$/i)?.[1]?.trim();
	if (bearerEnv) {
		return { type: "bearer", tokenEnv: bearerEnv };
	}

	const bearerToken = value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	if (bearerToken) {
		return { type: "bearer", token: bearerToken };
	}

	const basic = value.match(/^Basic\s+([^:]+):\{env:([^}]+)\}$/i);
	if (basic?.[1] && basic[2]) {
		return {
			type: "basic",
			username: basic[1],
			passwordEnv: basic[2],
		};
	}

	return null;
}

function buildRemoteServer(mcp: SourceMcpDefinition): WarmplaneServerConfig {
	const headers = { ...(mcp.config.headers || {}) };
	const authorization = Object.entries(headers).find(
		([name]) => name.toLowerCase() === "authorization",
	);
	const translatedAuth = authorization
		? translateAuthorizationHeader(authorization[1])
		: null;

	if (authorization && translatedAuth) {
		delete headers[authorization[0]];
	}

	if (mcp.oauthCapable) {
	return {
		url: mcp.config.url,
		protocolVersion: mcp.config.protocolVersion,
		allowStateless: mcp.config.allowStateless,
		headers,
		auth: {
			type: "oauth",
				...mcp.oauthConfig,
				tokenStoreKey: mcp.id,
			},
		};
	}

	return {
		url: mcp.config.url,
		protocolVersion: mcp.config.protocolVersion,
		allowStateless: mcp.config.allowStateless,
		headers,
		auth: translatedAuth || undefined,
	};
}

function buildLocalServer(mcp: SourceMcpDefinition): WarmplaneServerConfig {
	const [command, ...args] = mcp.config.command || [];
	return {
		command,
		args,
		env: { ...(mcp.config.environment || {}) },
	};
}

export function resolveWarmplaneConfigPath(configDir: string): string {
	return joinPath(configDir, "mcp0", "mcp_servers.json");
}

export function buildWarmplaneConfig(input: {
	mcps: SourceMcpDefinition[];
	authStorePath?: string;
}): WarmplaneConfig {
	const mcpServers = Object.fromEntries(
		input.mcps.map((mcp) => [
			mcp.id,
			mcp.config.type === "local"
				? buildLocalServer(mcp)
				: buildRemoteServer(mcp),
		]),
	);

	return {
		authStorePath: input.authStorePath,
		capabilityAliases: {},
		resourceAliases: {},
		promptAliases: {},
		policy: {
			allow: ["*"],
			deny: [],
			redactKeys: DEFAULT_REDACT_KEYS,
		},
		mcpServers,
	};
}

export function isMcp0Selected<T extends { id: string }>(mcps: T[]): boolean {
	return mcps.some((mcp) => mcp.id === "mcp0");
}

export function filterFacadeMcps<T extends { id: string }>(mcps: T[]): T[] {
	return mcps.filter((mcp) => mcp.id !== "mcp0");
}

export function resolveWarmplaneAuthStorePath(homeDir: string): string {
	return joinPath(homeDir, ".local", "share", "opencode", "mcp-auth.json");
}

export function extractRequiredEnvVars(config: WarmplaneConfig): string[] {
	const vars = new Set<string>();
	for (const server of Object.values(config.mcpServers)) {
		for (const value of Object.values(server.env || {})) {
			const envVar = parseEnvTemplate(value);
			if (envVar) vars.add(envVar);
		}
		for (const value of Object.values(server.headers || {})) {
			const envVar = parseEnvTemplate(value.replace(/^Bearer\s+/i, ""));
			if (envVar) vars.add(envVar);
		}
		if (server.auth?.type === "bearer" && server.auth.tokenEnv) {
			vars.add(server.auth.tokenEnv);
		}
		if (server.auth?.type === "basic" && server.auth.passwordEnv) {
			vars.add(server.auth.passwordEnv);
		}
	}
	return [...vars].sort();
}

async function readWarmplaneAuthStore(
	authStorePath?: string,
): Promise<Record<string, WarmplaneAuthStoreEntry>> {
	if (!authStorePath) return {};

	const file = Bun.file(authStorePath);
	if (!(await file.exists())) return {};

	try {
		const parsed = (await file.json()) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed as Record<string, WarmplaneAuthStoreEntry>;
	} catch {
		return {};
	}
}

function deriveWarmplaneAuthStatus(input: {
	entry?: WarmplaneAuthStoreEntry;
	serverUrl?: string;
	nowMs?: number;
}): WarmplanePointerAuthStatus {
	const { entry, serverUrl } = input;
	if (!entry?.tokens?.accessToken) {
		return "not_authenticated";
	}

	if (
		serverUrl &&
		entry.serverUrl &&
		!hasEnvTemplate(serverUrl) &&
		entry.serverUrl !== serverUrl
	) {
		return "not_authenticated";
	}

	if (
		typeof entry.tokens.expiresAt === "number" &&
		entry.tokens.expiresAt <= Math.floor((input.nowMs ?? Date.now()) / 1000)
	) {
		return "expired";
	}

	return "authenticated";
}

export async function buildWarmplanePointerAuthMetadata(input: {
	config: WarmplaneConfig;
	nowMs?: number;
}): Promise<Record<string, WarmplanePointerAuthMetadata>> {
	const store = await readWarmplaneAuthStore(input.config.authStorePath);
	const metadata: Record<string, WarmplanePointerAuthMetadata> = {};

	for (const [serverId, server] of Object.entries(input.config.mcpServers)) {
		if (server.auth?.type !== "oauth") continue;

		const tokenStoreKey =
			typeof server.auth.tokenStoreKey === "string" &&
			server.auth.tokenStoreKey.length > 0
				? server.auth.tokenStoreKey
				: serverId;
		const entry = store[tokenStoreKey];
		const authStatus = deriveWarmplaneAuthStatus({
			entry,
			serverUrl: server.url,
			nowMs: input.nowMs,
		});
		const hasClientId =
			(typeof server.auth.clientId === "string" &&
				server.auth.clientId.length > 0) ||
			(typeof entry?.clientInfo?.clientId === "string" &&
				entry.clientInfo.clientId.length > 0);
		const hasClientSecret =
			(typeof server.auth.clientSecret === "string" &&
				server.auth.clientSecret.length > 0) ||
			(typeof server.auth.clientSecretEnv === "string" &&
				server.auth.clientSecretEnv.length > 0) ||
			(typeof entry?.clientInfo?.clientSecret === "string" &&
				entry.clientInfo.clientSecret.length > 0);

		metadata[serverId] = {
			authStatus,
			hasClientId,
			hasClientSecret,
			lastErrorCode:
				authStatus === "expired"
					? "auth_expired"
					: authStatus === "not_authenticated"
						? "auth_missing"
						: undefined,
		};
	}

	return metadata;
}
