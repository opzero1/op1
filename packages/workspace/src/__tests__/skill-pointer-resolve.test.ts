import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createSkillPointerResolver } from "../skill-pointer/resolve";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

function hashContent(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

describe("skill pointer resolver", () => {
	test("resolves skill body from vault when index is valid", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-skill-pointer-resolve-"));
		tempRoots.push(root);

		const skillsRoot = join(root, "skills");
		const vaultRoot = join(root, "skill-vault");
		const skillName = "frontend-ui-ux";
		const vaultSkillPath = join(vaultRoot, "frontend", skillName, "SKILL.md");
		const skillBody = "# frontend-ui-ux\n\nIntentional UI patterns.";
		await Bun.write(vaultSkillPath, skillBody);

		await Bun.write(
			join(skillsRoot, ".skillpointer", "index.json"),
			JSON.stringify(
				{
					version: 1,
					vault_root: vaultRoot,
					categories: [
						{
							category: "frontend",
							skills: [
								{
									name: skillName,
									vault_path: `frontend/${skillName}/SKILL.md`,
									checksum_sha256: hashContent(skillBody),
								},
							],
						},
					],
				},
				null,
				2,
			),
		);

		const resolver = createSkillPointerResolver({
			enabled: true,
			skillsRoot,
		});

		const integrity = await resolver.validateIndex();
		expect(integrity.ok).toBe(true);

		const resolved = await resolver.resolveSkillBody(skillName);
		expect(resolved.source).toBe("vault");
		expect(resolved.content).toContain("Intentional UI patterns");
	});

	test("falls back to legacy skill body when vault entry is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-skill-pointer-resolve-"));
		tempRoots.push(root);

		const skillsRoot = join(root, "skills");
		const vaultRoot = join(root, "skill-vault");
		const skillName = "git-master";
		const legacyPath = join(skillsRoot, skillName, "SKILL.md");
		await Bun.write(legacyPath, "# git-master\n\nLegacy skill body.");

		await Bun.write(
			join(skillsRoot, ".skillpointer", "index.json"),
			JSON.stringify(
				{
					version: 1,
					vault_root: vaultRoot,
					categories: [
						{
							category: "workflow",
							skills: [
								{
									name: skillName,
									vault_path: `workflow/${skillName}/SKILL.md`,
									checksum_sha256: "deadbeef",
								},
							],
						},
					],
				},
				null,
				2,
			),
		);

		const resolver = createSkillPointerResolver({
			enabled: true,
			skillsRoot,
		});

		const resolved = await resolver.resolveSkillBody(skillName);
		expect(resolved.source).toBe("legacy");
		expect(resolved.warning).toContain("fallback");
		expect(resolved.code).toBe("pointer_unavailable_fallback");
		expect(resolved.content).toContain("Legacy skill body");
	});

	test("denies fallback in exclusive mode when vault entry is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-skill-pointer-resolve-"));
		tempRoots.push(root);

		const skillsRoot = join(root, "skills");
		const vaultRoot = join(root, "skill-vault");
		const skillName = "git-master";
		await Bun.write(
			join(skillsRoot, skillName, "SKILL.md"),
			"# git-master\n\nLegacy skill body.",
		);

		await Bun.write(
			join(skillsRoot, ".skillpointer", "index.json"),
			JSON.stringify(
				{
					version: 1,
					vault_root: vaultRoot,
					categories: [
						{
							category: "workflow",
							skills: [
								{
									name: skillName,
									vault_path: `workflow/${skillName}/SKILL.md`,
									checksum_sha256: "deadbeef",
								},
							],
						},
					],
				},
				null,
				2,
			),
		);

		const resolver = createSkillPointerResolver({
			enabled: true,
			mode: "exclusive",
			skillsRoot,
		});

		const resolved = await resolver.resolveSkillBody(skillName);
		expect(resolved.source).toBe("missing");
		expect(resolved.code).toBe("pointer_required_unavailable");
		expect(resolved.warning).toContain("exclusive mode denied fallback");
	});

	test("reports missing index when skill pointer mode is enabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-skill-pointer-resolve-"));
		tempRoots.push(root);

		const resolver = createSkillPointerResolver({
			enabled: true,
			skillsRoot: join(root, "skills"),
		});

		const integrity = await resolver.validateIndex();
		expect(integrity.ok).toBe(false);
		expect(integrity.issues[0]?.code).toBe("missing_index");
	});

	test("keeps legacy behavior when feature is disabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-skill-pointer-resolve-"));
		tempRoots.push(root);

		const skillsRoot = join(root, "skills");
		await Bun.write(
			join(skillsRoot, "write-clearly", "SKILL.md"),
			"# write-clearly\n\nLegacy-only skill.",
		);

		const resolver = createSkillPointerResolver({
			enabled: false,
			skillsRoot,
		});

		const integrity = await resolver.validateIndex();
		expect(integrity.ok).toBe(true);

		const resolved = await resolver.resolveSkillBody("write-clearly");
		expect(resolved.source).toBe("legacy");
	});

	test("falls back to external Claude-compatible skill roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-skill-pointer-resolve-"));
		tempRoots.push(root);

		const skillsRoot = join(root, "skills");
		const externalRoot = join(root, ".claude");
		await Bun.write(
			join(externalRoot, "skills", "claude-skill", "SKILL.md"),
			"# claude-skill\n\nExternal fallback.",
		);

		const resolver = createSkillPointerResolver({
			enabled: true,
			skillsRoot,
			externalSkillRoots: [externalRoot],
		});

		const resolved = await resolver.resolveSkillBody("claude-skill");
		expect(resolved.source).toBe("external");
		expect(resolved.content).toContain("External fallback");
	});
});
