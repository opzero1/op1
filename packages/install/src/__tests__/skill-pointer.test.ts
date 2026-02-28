import { afterEach, describe, expect, test } from "bun:test";
import {
	installSkillPointerArtifacts,
	rebuildSkillPointerArtifacts,
	validateSkillPointerIndex,
} from "../skill-pointer";

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
		`.op1-skill-pointer-test-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

async function createTempDir(prefix = "op1-skill-pointer-test-"): Promise<{
	path: string;
	cleanup: () => Promise<void>;
}> {
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

	return {
		path: tempPath,
		cleanup: async () => {
			const command = IS_WINDOWS
				? ["cmd", "/c", "rmdir", "/s", "/q", tempPath]
				: ["rm", "-rf", tempPath];
			const proc = Bun.spawn(command, {
				stdout: "ignore",
				stderr: "ignore",
			});
			const code = await proc.exited;
			if (code !== 0) {
				throw new Error(`Failed to cleanup temp directory: ${tempPath}`);
			}
		},
	};
}

async function writeSkill(
	templateSkillsDir: string,
	skillName: string,
	description: string,
): Promise<void> {
	const skillDir = join(templateSkillsDir, skillName);
	await ensureDirectory(skillDir);
	await Bun.write(
		join(skillDir, "SKILL.md"),
		`# ${skillName}\n\n${description}\n\nUse this skill for ${skillName}.\n`,
	);
	await Bun.write(join(skillDir, "notes.txt"), `extra ${skillName}`);
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const task of cleanupTasks.splice(0, cleanupTasks.length)) {
		await task();
	}
});

describe("skill pointer installer artifacts", () => {
	test("installs pointer index + vault artifacts with integrity validation", async () => {
		const temp = await createTempDir();
		cleanupTasks.push(temp.cleanup);

		const templateSkillsDir = join(temp.path, "templates", "skills");
		const activeSkillsDir = join(temp.path, "opencode", "skills");
		const vaultDir = join(temp.path, "opencode", "skill-vault");

		await writeSkill(
			templateSkillsDir,
			"frontend-ui-ux",
			"Frontend design guidance",
		);
		await writeSkill(
			templateSkillsDir,
			"terraform-master",
			"Infrastructure IaC guidance",
		);
		await writeSkill(
			templateSkillsDir,
			"plan-protocol",
			"Planning protocol guidance",
		);

		const result = await installSkillPointerArtifacts({
			templateSkillsDir,
			activeSkillsDir,
			vaultDir,
		});

		expect(result.applied).toBe(true);
		expect(result.index.total_skills).toBe(3);
		expect(result.index.pointer_count).toBeGreaterThan(0);
		expect(result.index.startup_token_estimate.legacy).toBeGreaterThan(0);
		expect(result.index.startup_token_estimate.pointer).toBeGreaterThan(0);
		expect(
			result.index.startup_token_estimate.reduction_percent,
		).toBeGreaterThanOrEqual(0);
		expect(result.index.startup_load_estimate_ms.legacy).toBeGreaterThan(0);
		expect(result.index.startup_load_estimate_ms.pointer).toBeGreaterThan(0);
		expect(
			result.index.startup_load_estimate_ms.improvement_percent,
		).toBeGreaterThanOrEqual(0);
		expect(await Bun.file(result.indexPath).exists()).toBe(true);

		const integrity = await validateSkillPointerIndex({
			indexPath: result.indexPath,
			activeSkillsDir,
			vaultDir,
		});

		expect(integrity.ok).toBe(true);
		expect(integrity.issues).toHaveLength(0);
	});

	test("supports dry-run estimation without writing files", async () => {
		const temp = await createTempDir();
		cleanupTasks.push(temp.cleanup);

		const templateSkillsDir = join(temp.path, "templates", "skills");
		const activeSkillsDir = join(temp.path, "opencode", "skills");
		const vaultDir = join(temp.path, "opencode", "skill-vault");

		await writeSkill(templateSkillsDir, "search-mode", "Search strategy");
		await writeSkill(templateSkillsDir, "code-review", "Code review process");

		const result = await installSkillPointerArtifacts({
			templateSkillsDir,
			activeSkillsDir,
			vaultDir,
			dryRun: true,
		});

		expect(result.applied).toBe(false);
		expect(result.fileWrites).toBeGreaterThan(0);
		expect(
			result.index.startup_token_estimate.reduction_percent,
		).toBeGreaterThanOrEqual(0);
		expect(
			result.index.startup_load_estimate_ms.improvement_percent,
		).toBeGreaterThanOrEqual(0);
		expect(await Bun.file(result.indexPath).exists()).toBe(false);
	});

	test("reports integrity failure when vault skill is missing", async () => {
		const temp = await createTempDir();
		cleanupTasks.push(temp.cleanup);

		const templateSkillsDir = join(temp.path, "templates", "skills");
		const activeSkillsDir = join(temp.path, "opencode", "skills");
		const vaultDir = join(temp.path, "opencode", "skill-vault");

		await writeSkill(templateSkillsDir, "git-master", "Git workflow guidance");

		const result = await installSkillPointerArtifacts({
			templateSkillsDir,
			activeSkillsDir,
			vaultDir,
		});

		const firstCategory = result.index.categories[0];
		expect(firstCategory).toBeDefined();
		const firstSkill = firstCategory?.skills[0];
		expect(firstSkill).toBeDefined();

		const vaultSkillPath = join(vaultDir, firstSkill?.vault_path ?? "");
		await Bun.file(vaultSkillPath).delete();

		const integrity = await validateSkillPointerIndex({
			indexPath: result.indexPath,
			activeSkillsDir,
			vaultDir,
		});

		expect(integrity.ok).toBe(false);
		expect(
			integrity.issues.some((issue) => issue.code === "missing_vault_skill"),
		).toBe(true);
	});

	test("rebuilds pointer index from existing vault and revalidates integrity", async () => {
		const temp = await createTempDir();
		cleanupTasks.push(temp.cleanup);

		const templateSkillsDir = join(temp.path, "templates", "skills");
		const activeSkillsDir = join(temp.path, "opencode", "skills");
		const vaultDir = join(temp.path, "opencode", "skill-vault");

		await writeSkill(templateSkillsDir, "validation", "Validation guidance");
		await writeSkill(templateSkillsDir, "search-mode", "Search guidance");

		const installed = await installSkillPointerArtifacts({
			templateSkillsDir,
			activeSkillsDir,
			vaultDir,
		});

		await Bun.file(installed.indexPath).delete();

		const rebuilt = await rebuildSkillPointerArtifacts({
			activeSkillsDir,
			vaultDir,
		});

		expect(rebuilt.applied).toBe(true);
		expect(await Bun.file(rebuilt.indexPath).exists()).toBe(true);

		const integrity = await validateSkillPointerIndex({
			indexPath: rebuilt.indexPath,
			activeSkillsDir,
			vaultDir,
		});
		expect(integrity.ok).toBe(true);
	});
});
