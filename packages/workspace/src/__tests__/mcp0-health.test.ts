import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { buildMcp0HealthSnapshot } from "../interop/mcp0-health";

const tempRoots: string[] = [];

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
		});

		expect(snapshot.found).toBe(true);
		expect(snapshot.servers[0]?.has_config_arg).toBe(false);
		expect(
			snapshot.issues.some((issue) => issue.includes("missing --config")),
		).toBe(true);
	});
});
