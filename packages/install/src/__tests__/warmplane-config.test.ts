import { describe, expect, test } from "bun:test";
import {
	applyMcp0FacadeMode,
	buildWarmplaneConfig,
	filterFacadeMcps,
	type McpDefinition,
	type OpenCodeConfig,
	resolveWarmplaneAuthStorePath,
	resolveWarmplaneConfigPath,
} from "../index";
import { resolveWarmplaneBinaryPath } from "../warmplane-binary";
import { buildWarmplanePointerAuthMetadata } from "../warmplane-config";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");

function join(...parts: string[]): string {
	const normalized = parts
		.filter((part) => part.length > 0)
		.map((part) => part.replace(/\\+/g, "/"));

	if (normalized.length === 0) return "";

	let result = normalized[0];
	for (let index = 1; index < normalized.length; index += 1) {
		const left = result.replace(/\/+$/, "");
		const right = normalized[index].replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return IS_WINDOWS ? result.replace(/\//g, "\\") : result;
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const marker = join(
		dirPath,
		`.op1-warmplane-config-test-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

async function createTempDir(
	prefix = "op1-warmplane-config-test-",
): Promise<string> {
	const root =
		Bun.env.TMPDIR ||
		Bun.env.TEMP ||
		Bun.env.TMP ||
		(IS_WINDOWS ? "C:\\Temp" : "/tmp");
	const tempPath = join(
		root,
		`${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	await ensureDirectory(tempPath);
	return tempPath;
}

async function removeDir(path: string): Promise<void> {
	const command = IS_WINDOWS
		? ["cmd", "/c", "rmdir", "/s", "/q", path]
		: ["rm", "-rf", path];
	const proc = Bun.spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	});
	await proc.exited;
}

describe("warmplane config helpers", () => {
	test("builds warmplane config from selected downstream mcps", () => {
		const mcps: McpDefinition[] = [
			{
				id: "linear",
				name: "Linear",
				description: "Issue tracking MCP",
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
				id: "figma",
				name: "Figma",
				description: "Design MCP",
				oauthCapable: true,
				config: {
					type: "remote",
					url: "https://mcp.figma.com/mcp",
				},
				toolPattern: "figma_*",
				agentAccess: ["researcher", "frontend"],
			},
			{
				id: "zai-vision",
				name: "Vision",
				description: "Vision MCP",
				config: {
					type: "local",
					command: ["bunx", "-y", "@z_ai/mcp-server"],
					environment: {
						Z_AI_API_KEY: "{env:Z_AI_API_KEY}",
					},
				},
				toolPattern: "zai-vision_*",
				agentAccess: ["coder"],
			},
			{
				id: "newrelic",
				name: "New Relic",
				description: "Monitoring MCP",
				config: {
					type: "remote",
					url: "https://mcp.newrelic.com/mcp/",
					headers: {
						"api-key": "{env:NEW_RELIC_API_KEY}",
					},
				},
				toolPattern: "newrelic_*",
				agentAccess: ["researcher"],
			},
		];

		const config = buildWarmplaneConfig({
			mcps,
			authStorePath: resolveWarmplaneAuthStorePath("/tmp/home"),
		});

		expect(config.authStorePath).toBe(
			"/tmp/home/.local/share/opencode/mcp-auth.json",
		);
		expect(config.mcpServers.linear?.auth).toEqual({
			type: "oauth",
			authorizationServer: "https://api.linear.app",
			authorizationEndpoint: "https://linear.app/oauth/authorize",
			tokenEndpoint: "https://api.linear.app/oauth/token",
			codeChallengeMethodsSupported: ["S256"],
			tokenStoreKey: "linear",
		});
		expect(config.mcpServers.figma?.auth).toEqual({
			type: "oauth",
			tokenStoreKey: "figma",
		});
		expect(config.mcpServers["zai-vision"]?.command).toBe("bunx");
			expect(config.mcpServers["zai-vision"]?.args).toEqual([
				"-y",
				"@z_ai/mcp-server",
			]);
			expect(config.mcpServers.newrelic?.allowStateless).toBeUndefined();
			expect(config.mcpServers.newrelic?.headers).toEqual({
				"api-key": "{env:NEW_RELIC_API_KEY}",
			});
		});

	test("preserves allowStateless for remote downstream MCPs", () => {
		const mcps: McpDefinition[] = [
			{
				id: "zai-search",
				name: "Web Search",
				description: "Stateless HTTP MCP",
				config: {
					type: "remote",
					url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
					allowStateless: true,
					headers: {
						Authorization: "Bearer {env:Z_AI_API_KEY}",
					},
				},
				toolPattern: "zai-search_*",
				agentAccess: ["researcher"],
			},
		];

		const config = buildWarmplaneConfig({ mcps });
		expect(config.mcpServers["zai-search"]?.allowStateless).toBe(true);
		expect(config.mcpServers["zai-search"]?.protocolVersion).toBeUndefined();
		expect(config.mcpServers["zai-search"]?.auth).toEqual({
			type: "bearer",
			tokenEnv: "Z_AI_API_KEY",
		});
	});

	test("preserves protocolVersion for remote downstream MCPs", () => {
		const mcps: McpDefinition[] = [
			{
				id: "grep_app",
				name: "grep.app",
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
		];

		const config = buildWarmplaneConfig({ mcps });
		expect(config.mcpServers.grep_app?.protocolVersion).toBe("2024-11-05");
		expect(config.mcpServers.grep_app?.allowStateless).toBe(true);
	});

	test("rewrites merged config into strict mcp0-only mode", () => {
		const existing: OpenCodeConfig = {
			mcp: {
				linear: { type: "remote", url: "https://mcp.linear.app/mcp" },
				context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
				"legacy-service": {
					type: "remote",
					url: "https://example.com/legacy",
				},
				custom: { type: "remote", url: "https://example.com/custom" },
			},
			tools: {
				"linear_*": false,
				"context7_*": false,
				"custom_*": false,
				"mcp0_*": false,
			},
			agent: {
				researcher: {
					tools: {
						"linear_*": true,
						"context7_*": true,
						"legacy-service_*": true,
						"custom_*": true,
						"mcp0_*": true,
					},
				},
			},
		};

		const next = applyMcp0FacadeMode({
			config: existing,
			warmplaneConfigPath: resolveWarmplaneConfigPath("/tmp/opencode"),
			warmplaneBinaryPath: resolveWarmplaneBinaryPath("/tmp/home"),
		});

		expect(next.mcp?.linear).toBeUndefined();
		expect(next.mcp?.context7).toBeUndefined();
		expect(next.mcp?.custom).toBeUndefined();
		expect(next.mcp?.mcp0).toEqual({
			type: "local",
			command: [
				resolveWarmplaneBinaryPath("/tmp/home"),
				"mcp-server",
				"--config",
				"/tmp/opencode/mcp0/mcp_servers.json",
			],
		});
		expect(next.tools?.["linear_*"]).toBeUndefined();
		expect(next.tools?.["context7_*"]).toBeUndefined();
		expect(next.tools?.["custom_*"]).toBeUndefined();
		expect(next.agent?.researcher?.tools?.["linear_*"]).toBeUndefined();
		expect(next.agent?.researcher?.tools?.["context7_*"]).toBeUndefined();
		expect(next.agent?.researcher?.tools?.["legacy-service_*"]).toBeUndefined();
		expect(next.agent?.researcher?.tools?.["custom_*"]).toBeUndefined();
		expect(next.agent?.researcher?.tools?.["mcp0_*"]).toBe(true);
	});

	test("filters facade downstream mcps by excluding mcp0 itself", () => {
		const mcps: McpDefinition[] = [
			{
				id: "mcp0",
				name: "mcp0",
				description: "Facade",
				config: { type: "local", command: ["warmplane", "mcp-server"] },
				toolPattern: "mcp0_*",
				agentAccess: ["researcher"],
			},
			{
				id: "figma",
				name: "Figma",
				description: "Design",
				oauthCapable: true,
				config: { type: "remote", url: "https://mcp.figma.com/mcp" },
				toolPattern: "figma_*",
				agentAccess: ["frontend"],
			},
		];

		expect(filterFacadeMcps(mcps).map((mcp) => mcp.id)).toEqual(["figma"]);
	});

	test("derives pointer auth metadata from warmplane auth store", async () => {
		const tempDir = await createTempDir();
		try {
			const authStorePath = join(tempDir, "mcp-auth.json");
			await Bun.write(
				authStorePath,
				JSON.stringify(
					{
						figma: {
							tokens: {
								accessToken: "figma-token",
								expiresAt: Math.floor(Date.now() / 1000) + 3600,
							},
							serverUrl: "https://mcp.figma.com/mcp",
						},
						notion: {
							tokens: {
								accessToken: "notion-token",
								expiresAt: Math.floor(Date.now() / 1000) - 60,
							},
							serverUrl: "https://mcp.notion.com/mcp",
						},
					},
					null,
					2,
				),
			);

			const metadata = await buildWarmplanePointerAuthMetadata({
				config: {
					authStorePath,
					capabilityAliases: {},
					resourceAliases: {},
					promptAliases: {},
					policy: {
						allow: ["*"],
						deny: [],
						redactKeys: [],
					},
					mcpServers: {
						figma: {
							url: "https://mcp.figma.com/mcp",
							auth: {
								type: "oauth",
								tokenStoreKey: "figma",
							},
						},
						notion: {
							url: "https://mcp.notion.com/mcp",
							auth: {
								type: "oauth",
								clientId: "notion-client",
								clientSecretEnv: "NOTION_CLIENT_SECRET",
							},
						},
						linear: {
							url: "https://mcp.linear.app/mcp",
							auth: {
								type: "oauth",
								tokenStoreKey: "linear",
							},
						},
					},
				},
			});

			expect(metadata.figma).toEqual({
				authStatus: "authenticated",
				hasClientId: false,
				hasClientSecret: false,
				lastErrorCode: undefined,
			});
			expect(metadata.notion).toEqual({
				authStatus: "expired",
				hasClientId: true,
				hasClientSecret: true,
				lastErrorCode: "auth_expired",
			});
			expect(metadata.linear).toEqual({
				authStatus: "not_authenticated",
				hasClientId: false,
				hasClientSecret: false,
				lastErrorCode: "auth_missing",
			});
		} finally {
			await removeDir(tempDir);
		}
	});
});
