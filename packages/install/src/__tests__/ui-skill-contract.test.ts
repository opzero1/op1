import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const templatesDir = join(import.meta.dir, "..", "..", "templates");

async function readTemplate(...parts: string[]): Promise<string> {
	return Bun.file(join(templatesDir, ...parts)).text();
}

describe("ui skill template contract", () => {
	test("ships direct and mcp0 fetch guidance", async () => {
		const uiSkill = await readTemplate("skills", "ui", "SKILL.md");

		expect(uiSkill).toContain("name: ui");
		expect(uiSkill).toContain("uidotsh://ui");
		expect(uiSkill).toContain("uidotsh_uidotsh_fetch");
		expect(uiSkill).toContain("mcp0_*");
		expect(uiSkill).toContain("uidotsh.uidotsh_fetch");
	});
});
