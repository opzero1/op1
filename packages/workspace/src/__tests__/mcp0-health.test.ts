import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { buildMcp0HealthSnapshot } from "../interop/mcp0-health";

const tempRoots: string[] = [];
const resolveWarmplaneBinary = async (command: string) =>
	command === "warmplane" ? "/usr/local/bin/warmplane" : null;

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("mcp0 health helper", () => {
	test("reports missing mcp0 configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp0-health-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");
		await mkdir(join(directory, ".opencode"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						context7: {
							type: "remote",
							url: "https://mcp.context7.com/mcp",
						},
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcp0HealthSnapshot({
			directory,
			homeDirectory,
			resolveCommandPath: resolveWarmplaneBinary,
		});

		expect(snapshot.found).toBe(false);
		expect(snapshot.issues[0]).toContain("No mcp0 server found");
	});

	test("reports config guidance when mcp0 command lacks --config", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp0-health-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");
		await mkdir(join(directory, ".opencode"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						mcp0: {
							type: "local",
							command: ["warmplane", "mcp-server"],
						},
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcp0HealthSnapshot({
			directory,
			homeDirectory,
			resolveCommandPath: resolveWarmplaneBinary,
		});

		expect(snapshot.found).toBe(true);
		expect(snapshot.servers[0]?.binary_found).toBe(true);
		expect(snapshot.servers[0]?.has_config_arg).toBe(false);
		expect(
			snapshot.issues.some((issue) => issue.includes("missing --config")),
		).toBe(true);
	});

	test("reports missing warmplane binary", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp0-health-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");
		await mkdir(join(directory, ".opencode"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						mcp0: {
							type: "local",
							command: ["warmplane", "mcp-server", "--config", "missing.json"],
						},
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcp0HealthSnapshot({
			directory,
			homeDirectory,
			resolveCommandPath: async () => null,
		});

		expect(snapshot.found).toBe(true);
		expect(snapshot.servers[0]?.binary_found).toBe(false);
		expect(
			snapshot.issues.some((issue) => issue.includes("Warmplane binary")),
		).toBe(true);
	});

	test("loads referenced warmplane config details when --config is present", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp0-health-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");
		const warmplaneConfigPath = join(root, "mcp0", "mcp_servers.json");
		await mkdir(join(directory, ".opencode"), { recursive: true });
		await mkdir(join(root, "mcp0"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						mcp0: {
							type: "local",
							command: [
								"warmplane",
								"mcp-server",
								"--config",
								warmplaneConfigPath,
							],
						},
					},
				},
				null,
				2,
			),
		);
		await Bun.write(
			warmplaneConfigPath,
			JSON.stringify(
				{
					authStorePath: join(
						homeDirectory,
						".local",
						"share",
						"opencode",
						"mcp-auth.json",
					),
					mcpServers: {
						figma: {
							url: "https://mcp.figma.com/mcp",
							auth: { type: "oauth" },
						},
						context7: {
							url: "https://mcp.context7.com/mcp",
						},
					},
				},
				null,
				2,
			),
		);
		await mkdir(join(homeDirectory, ".local", "share", "opencode"), {
			recursive: true,
		});
		await Bun.write(
			join(homeDirectory, ".local", "share", "opencode", "mcp-auth.json"),
			JSON.stringify(
				{
					figma: {
						tokens: {
							accessToken: "token",
							expiresAt: Math.floor(Date.now() / 1000) + 3600,
						},
						serverUrl: "https://mcp.figma.com/mcp",
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcp0HealthSnapshot({
			directory,
			homeDirectory,
			resolveCommandPath: resolveWarmplaneBinary,
		});

		expect(snapshot.found).toBe(true);
		expect(snapshot.issues).toHaveLength(0);
		expect(snapshot.servers[0]?.binary_found).toBe(true);
		expect(snapshot.servers[0]?.has_config_arg).toBe(true);
		expect(snapshot.servers[0]?.warmplane_config_found).toBe(true);
		expect(snapshot.servers[0]?.upstream_count).toBe(2);
		expect(snapshot.servers[0]?.oauth_upstream_count).toBe(1);
		expect(snapshot.servers[0]?.oauth_ready_count).toBe(1);
		expect(snapshot.servers[0]?.oauth_not_ready_count).toBe(0);
		expect(snapshot.servers[0]?.downstream_oauth_servers).toHaveLength(1);
		expect(
			snapshot.servers[0]?.downstream_oauth_servers?.[0]?.auth_status,
		).toBe("authenticated");
	});

	test("reports downstream oauth readiness gaps behind mcp0", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp0-health-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");
		const warmplaneConfigPath = join(root, "mcp0", "mcp_servers.json");
		await mkdir(join(directory, ".opencode"), { recursive: true });
		await mkdir(join(root, "mcp0"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						mcp0: {
							type: "local",
							command: [
								"warmplane",
								"mcp-server",
								"--config",
								warmplaneConfigPath,
							],
						},
					},
				},
				null,
				2,
			),
		);
		await Bun.write(
			warmplaneConfigPath,
			JSON.stringify(
				{
					mcpServers: {
						figma: {
							url: "https://mcp.figma.com/mcp",
							auth: { type: "oauth" },
						},
						notion: {
							url: "https://mcp.notion.com/mcp",
							auth: { type: "oauth" },
						},
					},
				},
				null,
				2,
			),
		);
		await mkdir(join(homeDirectory, ".local", "share", "opencode"), {
			recursive: true,
		});
		await Bun.write(
			join(homeDirectory, ".local", "share", "opencode", "mcp-auth.json"),
			JSON.stringify(
				{
					notion: {
						tokens: {
							accessToken: "expired-token",
							expiresAt: Math.floor(Date.now() / 1000) - 10,
						},
						serverUrl: "https://mcp.notion.com/mcp",
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcp0HealthSnapshot({
			directory,
			homeDirectory,
			resolveCommandPath: resolveWarmplaneBinary,
		});

		expect(snapshot.found).toBe(true);
		expect(snapshot.servers[0]?.oauth_upstream_count).toBe(2);
		expect(snapshot.servers[0]?.oauth_ready_count).toBe(0);
		expect(snapshot.servers[0]?.oauth_not_ready_count).toBe(2);
		expect(
			snapshot.servers[0]?.downstream_oauth_servers?.map((entry) => [
				entry.name,
				entry.auth_status,
			]),
		).toEqual([
			["figma", "not_authenticated"],
			["notion", "expired"],
		]);
		expect(
			snapshot.issues.some((issue) => issue.includes("figma, notion")),
		).toBe(true);
	});
});
