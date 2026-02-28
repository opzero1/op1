import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { discoverClaudeCompatAssets } from "../interop/claude-compat";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("claude compatibility scanner", () => {
	test("discovers project and global compatible assets", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-claude-compat-test-"));
		tempRoots.push(root);

		const projectDir = join(root, "project");
		const homeDir = join(root, "home");
		await mkdir(join(projectDir, ".claude", "skills", "demo-skill"), {
			recursive: true,
		});
		await mkdir(join(homeDir, ".agents", "commands"), { recursive: true });

		await Bun.write(
			join(projectDir, ".claude", "skills", "demo-skill", "SKILL.md"),
			"# demo\n",
		);
		await Bun.write(join(homeDir, ".agents", "commands", "sync.md"), "sync");

		const snapshot = await discoverClaudeCompatAssets({
			directory: projectDir,
			homeDirectory: homeDir,
		});

		expect(snapshot.totals.skills).toBe(1);
		expect(snapshot.totals.commands).toBe(1);
		expect(snapshot.assets.some((asset) => asset.scope === "project")).toBe(
			true,
		);
		expect(snapshot.assets.some((asset) => asset.scope === "global")).toBe(
			true,
		);
	});
});
