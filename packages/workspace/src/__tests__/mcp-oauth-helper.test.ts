import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { buildMcpOAuthHelperSnapshot } from "../interop/mcp-oauth-helper";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("mcp oauth helper", () => {
	test("detects oauth-capable remote servers and auth status", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-oauth-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");

		await mkdir(join(directory, ".opencode"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						linear: {
							type: "remote",
							url: "https://mcp.linear.app/mcp",
							oauth: {},
						},
						context7: {
							type: "remote",
							url: "https://mcp.context7.com/mcp",
							oauth: false,
						},
						figma: {
							type: "remote",
							url: "https://mcp.figma.com/mcp",
						},
					},
				},
				null,
				2,
			),
		);

		const authStorePath = join(
			homeDirectory,
			".local",
			"share",
			"opencode",
			"mcp-auth.json",
		);
		await mkdir(join(homeDirectory, ".local", "share", "opencode"), {
			recursive: true,
		});
		await Bun.write(
			authStorePath,
			JSON.stringify(
				{
					linear: {
						tokens: {
							accessToken: "token",
							expiresAt: Math.floor(Date.now() / 1000) + 3600,
						},
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcpOAuthHelperSnapshot({
			directory,
			homeDirectory,
		});

		expect(snapshot.auth_store_path).toBe(authStorePath);
		expect(snapshot.servers).toHaveLength(1);
		expect(snapshot.servers[0]?.name).toBe("linear");
		expect(snapshot.servers[0]?.auth_status).toBe("authenticated");
		expect(snapshot.servers[0]?.recommended_action).toContain(
			"opencode mcp debug",
		);
	});

	test("reports expired and missing auth statuses", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-oauth-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");

		await mkdir(join(directory, ".opencode"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						linear: {
							type: "remote",
							url: "https://mcp.linear.app/mcp",
							oauth: {},
						},
						notion: {
							type: "remote",
							url: "https://mcp.notion.com/mcp",
							oauth: {},
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
					linear: {
						tokens: {
							accessToken: "expired-token",
							expiresAt: Math.floor(Date.now() / 1000) - 10,
						},
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcpOAuthHelperSnapshot({
			directory,
			homeDirectory,
		});

		const linear = snapshot.servers.find((server) => server.name === "linear");
		const notion = snapshot.servers.find((server) => server.name === "notion");
		expect(linear?.auth_status).toBe("expired");
		expect(notion?.auth_status).toBe("not_authenticated");
	});

	test("includes local mcp-remote servers as oauth-capable", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-oauth-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");

		await mkdir(join(directory, ".opencode"), { recursive: true });
		await Bun.write(
			join(directory, ".opencode", "opencode.json"),
			JSON.stringify(
				{
					mcp: {
						linear: {
							type: "local",
							command: [
								"bunx",
								"-y",
								"mcp-remote",
								"https://mcp.linear.app/mcp",
							],
						},
					},
				},
				null,
				2,
			),
		);

		const snapshot = await buildMcpOAuthHelperSnapshot({
			directory,
			homeDirectory,
		});
		expect(snapshot.servers).toHaveLength(1);
		expect(snapshot.servers[0]?.name).toBe("linear");
		expect(snapshot.servers[0]?.auth_status).toBe("not_authenticated");
	});

	test("detects warmplane-managed oauth upstreams behind mcp0", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-oauth-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");
		const warmplaneDir = join(homeDirectory, ".config", "opencode", "mcp0");
		const warmplaneConfigPath = join(warmplaneDir, "mcp_servers.json");
		await mkdir(join(directory, ".opencode"), { recursive: true });
		await mkdir(warmplaneDir, { recursive: true });
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
							auth: {
								type: "oauth",
								tokenStoreKey: "figma",
							},
						},
					},
				},
				null,
				2,
			),
		);

		const authStorePath = join(
			homeDirectory,
			".local",
			"share",
			"opencode",
			"mcp-auth.json",
		);
		await mkdir(join(homeDirectory, ".local", "share", "opencode"), {
			recursive: true,
		});
		await Bun.write(
			authStorePath,
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

		const snapshot = await buildMcpOAuthHelperSnapshot({
			directory,
			homeDirectory,
		});

		expect(snapshot.auth_store_path).toBe(authStorePath);
		expect(snapshot.servers).toHaveLength(1);
		expect(snapshot.servers[0]?.name).toBe("figma");
		expect(snapshot.servers[0]?.managed_by).toBe("warmplane");
		expect(snapshot.servers[0]?.auth_status).toBe("authenticated");
		expect(snapshot.servers[0]?.recommended_action).toContain(
			"warmplane auth status",
		);
	});

	test("uses the highest-precedence mcp0 config and its explicit auth store", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-mcp-oauth-test-"));
		tempRoots.push(root);

		const directory = join(root, "project");
		const homeDirectory = join(root, "home");
		const globalConfigPath = join(
			homeDirectory,
			".config",
			"opencode",
			"opencode.json",
		);
		const globalWarmplanePath = join(root, "global-mcp0", "mcp_servers.json");
		const projectWarmplanePath = join(root, "project-mcp0", "mcp_servers.json");
		const projectAuthStorePath = join(root, "project-auth", "mcp-auth.json");

		await mkdir(join(directory, ".opencode"), { recursive: true });
		await mkdir(join(homeDirectory, ".config", "opencode"), {
			recursive: true,
		});
		await mkdir(join(root, "global-mcp0"), { recursive: true });
		await mkdir(join(root, "project-mcp0"), { recursive: true });
		await mkdir(join(root, "project-auth"), { recursive: true });

		await Bun.write(
			globalConfigPath,
			JSON.stringify(
				{
					mcp: {
						mcp0: {
							type: "local",
							command: [
								"warmplane",
								"mcp-server",
								"--config",
								globalWarmplanePath,
							],
						},
					},
				},
				null,
				2,
			),
		);
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
								projectWarmplanePath,
							],
						},
					},
				},
				null,
				2,
			),
		);
		await Bun.write(
			globalWarmplanePath,
			JSON.stringify(
				{
					mcpServers: {
						figma: {
							url: "https://mcp.figma.com/mcp",
							auth: { type: "oauth" },
						},
					},
				},
				null,
				2,
			),
		);
		await Bun.write(
			projectWarmplanePath,
			JSON.stringify(
				{
					authStorePath: projectAuthStorePath,
					mcpServers: {
						figma: {
							url: "https://mcp.figma.com/mcp",
							auth: { type: "oauth" },
						},
					},
				},
				null,
				2,
			),
		);
		await Bun.write(
			projectAuthStorePath,
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

		const snapshot = await buildMcpOAuthHelperSnapshot({
			directory,
			homeDirectory,
		});

		expect(snapshot.auth_store_path).toBe(projectAuthStorePath);
		expect(snapshot.servers[0]?.auth_status).toBe("authenticated");
		expect(snapshot.servers[0]?.warmplane_config_path).toBe(
			projectWarmplanePath,
		);
	});
});
