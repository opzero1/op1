import {
	computeContractChecksum,
	isCompatibleSchemaVersion,
	SKILL_POINTER_CONTRACT_SCHEMA_VERSION,
} from "./skill-pointer-contract.js";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");

function toPosixPath(input: string): string {
	return input.replace(/\\+/g, "/");
}

function isAbsolutePath(input: string): boolean {
	if (input.startsWith("/")) return true;
	return /^[A-Za-z]:\//.test(input);
}

function toNativePath(input: string): string {
	if (!IS_WINDOWS) return input;
	return input.replace(/\//g, "\\");
}

function joinPath(...parts: string[]): string {
	const normalized = parts
		.map((part) => part)
		.filter((part) => part.length > 0)
		.map((part) => toPosixPath(part));

	if (normalized.length === 0) return "";

	let result = normalized[0];
	for (let index = 1; index < normalized.length; index += 1) {
		const part = normalized[index];
		if (isAbsolutePath(part)) {
			result = part;
			continue;
		}

		const left = result.replace(/\/+$/, "");
		const right = part.replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return toNativePath(result);
}

function toRelativePath(basePath: string, targetPath: string): string {
	const basePosix = toPosixPath(basePath).replace(/\/+$/, "");
	const targetPosix = toPosixPath(targetPath);
	if (targetPosix === basePosix) return "";
	const prefix = `${basePosix}/`;
	if (targetPosix.startsWith(prefix)) {
		return targetPosix.slice(prefix.length);
	}
	return targetPosix;
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const marker = joinPath(
		dirPath,
		`.op1-skill-pointer-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

async function listFilesRecursively(dirPath: string): Promise<string[]> {
	const files: string[] = [];
	for await (const file of new Bun.Glob("**/*").scan({
		cwd: dirPath,
		onlyFiles: true,
		absolute: false,
	})) {
		files.push(file);
	}

	return files;
}

async function copyDir(src: string, dest: string): Promise<number> {
	await ensureDirectory(dest);
	const files = await listFilesRecursively(src);
	for (const relativeFile of files) {
		const srcPath = joinPath(src, relativeFile);
		const destPath = joinPath(dest, relativeFile);
		await Bun.write(destPath, Bun.file(srcPath));
	}
	return files.length;
}

function hashContent(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

const POINTER_INDEX_VERSION = 1;
const POINTER_INDEX_DIR = ".skillpointer";
const POINTER_INDEX_FILE = "index.json";

const CATEGORY_KEYWORDS: Array<{ category: string; keywords: string[] }> = [
	{ category: "planning", keywords: ["plan", "brainstorm", "analyze"] },
	{
		category: "frontend",
		keywords: ["frontend", "react", "figma", "ui", "ux"],
	},
	{ category: "backend", keywords: ["backend", "nestjs", "database", "http"] },
	{
		category: "infrastructure",
		keywords: ["terraform", "tmux", "mcp", "infra"],
	},
	{
		category: "quality",
		keywords: ["review", "verification", "debug", "validation"],
	},
	{
		category: "workflow",
		keywords: ["git", "context", "search", "skill", "write"],
	},
	{ category: "research", keywords: ["docs", "notion", "linear", "newrelic"] },
];

export interface SkillPointerSkillEntry {
	name: string;
	description: string;
	checksum_sha256: string;
	source_path: string;
	vault_path: string;
	bytes: number;
}

export interface SkillPointerCategoryEntry {
	category: string;
	pointer_name: string;
	pointer_path: string;
	skills: SkillPointerSkillEntry[];
}

export interface SkillPointerIndex {
	version: 1;
	contract: {
		schema_version: string;
		release_train_id: string;
		source_contract_sha: string;
		normalized_sha256: string;
	};
	generated_at: string;
	vault_root: string;
	total_skills: number;
	pointer_count: number;
	startup_token_estimate: {
		legacy: number;
		pointer: number;
		reduction_percent: number;
	};
	startup_load_estimate_ms: {
		legacy: number;
		pointer: number;
		improvement_percent: number;
	};
	categories: SkillPointerCategoryEntry[];
}

export interface SkillPointerIntegrityIssue {
	code: string;
	message: string;
	path?: string;
}

export interface SkillPointerIntegrityResult {
	ok: boolean;
	issues: SkillPointerIntegrityIssue[];
}

export interface InstallSkillPointerOptions {
	templateSkillsDir: string;
	activeSkillsDir: string;
	vaultDir: string;
	dryRun?: boolean;
	nowMs?: number;
	releaseTrainId?: string;
	sourceContractSha?: string;
}

export interface InstallSkillPointerResult {
	applied: boolean;
	fileWrites: number;
	indexPath: string;
	index: SkillPointerIndex;
}

interface DiscoveredSkill {
	name: string;
	sourceDir: string;
	sourceSkillPath: string;
	vaultDir: string;
	vaultSkillPath: string;
	description: string;
	content: string;
	category: string;
}

function inferCategory(skillName: string): string {
	const normalized = skillName.toLowerCase();
	for (const candidate of CATEGORY_KEYWORDS) {
		if (candidate.keywords.some((keyword) => normalized.includes(keyword))) {
			return candidate.category;
		}
	}
	return "general";
}

function sanitizeLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function extractSkillDescription(content: string): string {
	const lines = content.split("\n");
	for (const rawLine of lines) {
		const line = sanitizeLine(rawLine);
		if (!line) continue;
		if (line.startsWith("#")) continue;
		if (line.startsWith("```")) continue;
		return line.length > 140 ? `${line.slice(0, 137)}...` : line;
	}
	return "Category skill reference.";
}

function buildPointerSkillBody(input: {
	category: string;
	vaultCategoryDir: string;
	skills: SkillPointerSkillEntry[];
}): string {
	const title = `${input.category}-category-pointer`;
	const skillLines = input.skills
		.map((skill) => `- ${skill.name}: ${skill.description}`)
		.join("\n");

	return [
		`# ${title}`,
		"",
		`Use this pointer to locate ${input.category} skills in the vault and load only the exact skill needed.`,
		"",
		"Workflow:",
		`1. Read vault directory: ${toPosixPath(input.vaultCategoryDir)}`,
		"2. Pick the most relevant skill folder by name.",
		"3. Read that folder's SKILL.md before implementing.",
		"4. Fall back to standard project reasoning if no vault skill applies.",
		"",
		"Indexed skills:",
		skillLines,
		"",
	].join("\n");
}

async function discoverTemplateSkills(
	templateSkillsDir: string,
	vaultDir: string,
): Promise<DiscoveredSkill[]> {
	const discovered: DiscoveredSkill[] = [];

	for await (const skillFile of new Bun.Glob("*/SKILL.md").scan({
		cwd: templateSkillsDir,
		onlyFiles: true,
		absolute: false,
	})) {
		const normalized = toPosixPath(skillFile);
		const slashIndex = normalized.indexOf("/");
		if (slashIndex <= 0) continue;

		const skillName = normalized.slice(0, slashIndex);
		const sourceDir = joinPath(templateSkillsDir, skillName);
		const sourceSkillPath = joinPath(sourceDir, "SKILL.md");
		const file = Bun.file(sourceSkillPath);
		if (!(await file.exists())) continue;

		const content = await file.text();
		const category = inferCategory(skillName);
		const vaultSkillDir = joinPath(vaultDir, category, skillName);
		const vaultSkillPath = joinPath(vaultSkillDir, "SKILL.md");

		discovered.push({
			name: skillName,
			sourceDir,
			sourceSkillPath,
			vaultDir: vaultSkillDir,
			vaultSkillPath,
			description: extractSkillDescription(content),
			content,
			category,
		});
	}

	return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

function buildPointerIndex(input: {
	nowMs: number;
	sourceRoot: string;
	vaultDir: string;
	discovered: DiscoveredSkill[];
	releaseTrainId: string;
	sourceContractSha: string;
}): SkillPointerIndex {
	const byCategory = new Map<string, DiscoveredSkill[]>();
	for (const skill of input.discovered) {
		const existing = byCategory.get(skill.category) ?? [];
		existing.push(skill);
		byCategory.set(skill.category, existing);
	}

	const categories: SkillPointerCategoryEntry[] = [...byCategory.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([category, skills]) => {
			const pointerName = `${category}-category-pointer`;
			const pointerPath = joinPath(pointerName, "SKILL.md");
			const skillEntries = skills
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((skill) => ({
					name: skill.name,
					description: skill.description,
					checksum_sha256: hashContent(skill.content),
					source_path: toRelativePath(input.sourceRoot, skill.sourceSkillPath),
					vault_path: toRelativePath(input.vaultDir, skill.vaultSkillPath),
					bytes: skill.content.length,
				}));

			return {
				category,
				pointer_name: pointerName,
				pointer_path: toPosixPath(pointerPath),
				skills: skillEntries,
			};
		});

	const legacyTokenEstimate = input.discovered.reduce((sum, skill) => {
		return sum + estimateTokens(`${skill.name} ${skill.description}`);
	}, 0);

	const pointerTokenEstimate = categories.reduce((sum, category) => {
		return (
			sum +
			estimateTokens(
				`${category.pointer_name} pointer for ${category.skills.length} skills in ${category.category}`,
			)
		);
	}, 0);

	const rawReductionPercent =
		legacyTokenEstimate > 0
			? ((legacyTokenEstimate - pointerTokenEstimate) / legacyTokenEstimate) *
				100
			: 0;
	const reductionPercent = Math.max(0, Number(rawReductionPercent.toFixed(2)));

	const legacyLoadEstimateMs = Number(
		(input.discovered.length * 1.8 + legacyTokenEstimate * 0.01).toFixed(2),
	);
	const pointerLoadEstimateMs = Number(
		(categories.length * 1.2 + pointerTokenEstimate * 0.01 + 2).toFixed(2),
	);
	const rawLoadImprovementPercent =
		legacyLoadEstimateMs > 0
			? ((legacyLoadEstimateMs - pointerLoadEstimateMs) /
					legacyLoadEstimateMs) *
				100
			: 0;
	const loadImprovementPercent = Math.max(
		0,
		Number(rawLoadImprovementPercent.toFixed(2)),
	);

	const contract = {
		schema_version: SKILL_POINTER_CONTRACT_SCHEMA_VERSION,
		release_train_id: input.releaseTrainId,
		source_contract_sha: input.sourceContractSha,
		normalized_sha256: "",
	};

	contract.normalized_sha256 = computeContractChecksum({
		schema_version: contract.schema_version,
		release_train_id: contract.release_train_id,
		source_contract_sha: contract.source_contract_sha,
		allowed_modes: ["fallback", "exclusive"],
		failure_classes: [
			"pointer_required_unavailable",
			"pointer_integrity_mismatch",
			"pointer_unavailable_fallback",
		],
		materialization_states: ["stubbed", "materializing", "ready", "degraded"],
		required_payload_fields: [
			"schema_version",
			"release_train_id",
			"source_contract_sha",
			"allowed_modes",
			"failure_classes",
			"materialization_states",
		],
	});

	return {
		version: POINTER_INDEX_VERSION,
		contract,
		generated_at: new Date(input.nowMs).toISOString(),
		vault_root: toPosixPath(input.vaultDir),
		total_skills: input.discovered.length,
		pointer_count: categories.length,
		startup_token_estimate: {
			legacy: legacyTokenEstimate,
			pointer: pointerTokenEstimate,
			reduction_percent: reductionPercent,
		},
		startup_load_estimate_ms: {
			legacy: legacyLoadEstimateMs,
			pointer: pointerLoadEstimateMs,
			improvement_percent: loadImprovementPercent,
		},
		categories,
	};
}

async function discoverVaultSkills(
	vaultDir: string,
): Promise<DiscoveredSkill[]> {
	const discovered: DiscoveredSkill[] = [];

	for await (const skillFile of new Bun.Glob("*/*/SKILL.md").scan({
		cwd: vaultDir,
		onlyFiles: true,
		absolute: false,
	})) {
		const normalized = toPosixPath(skillFile);
		const parts = normalized.split("/");
		if (parts.length !== 3) continue;

		const category = parts[0];
		const skillName = parts[1];
		if (!category || !skillName) continue;

		const sourceDir = joinPath(vaultDir, category, skillName);
		const sourceSkillPath = joinPath(sourceDir, "SKILL.md");
		const file = Bun.file(sourceSkillPath);
		if (!(await file.exists())) continue;

		const content = await file.text();

		discovered.push({
			name: skillName,
			sourceDir,
			sourceSkillPath,
			vaultDir: sourceDir,
			vaultSkillPath: sourceSkillPath,
			description: extractSkillDescription(content),
			content,
			category,
		});
	}

	return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

export async function validateSkillPointerIndex(input: {
	indexPath: string;
	activeSkillsDir: string;
	vaultDir: string;
}): Promise<SkillPointerIntegrityResult> {
	const issues: SkillPointerIntegrityIssue[] = [];
	const indexFile = Bun.file(input.indexPath);
	if (!(await indexFile.exists())) {
		return {
			ok: false,
			issues: [
				{
					code: "missing_index",
					message: "SkillPointer index file was not generated.",
					path: input.indexPath,
				},
			],
		};
	}

	let index: SkillPointerIndex | null = null;
	try {
		index = (await indexFile.json()) as SkillPointerIndex;
	} catch {
		issues.push({
			code: "malformed_index",
			message: "SkillPointer index is not valid JSON.",
			path: input.indexPath,
		});
	}

	if (!index) {
		return { ok: false, issues };
	}

	if (index.version !== POINTER_INDEX_VERSION) {
		issues.push({
			code: "unsupported_version",
			message: `SkillPointer index version ${index.version} is unsupported.`,
			path: input.indexPath,
		});
	}

	if (
		!isCompatibleSchemaVersion({
			readerVersion: SKILL_POINTER_CONTRACT_SCHEMA_VERSION,
			writerVersion: index.contract?.schema_version ?? "0.0.0",
		})
	) {
		issues.push({
			code: "unsupported_contract_schema",
			message: `SkillPointer contract schema ${index.contract?.schema_version ?? "unknown"} is incompatible with reader ${SKILL_POINTER_CONTRACT_SCHEMA_VERSION}.`,
			path: input.indexPath,
		});
	}

	for (const category of index.categories ?? []) {
		const pointerPath = joinPath(input.activeSkillsDir, category.pointer_path);
		if (!(await Bun.file(pointerPath).exists())) {
			issues.push({
				code: "missing_pointer",
				message: `Pointer SKILL.md missing for ${category.pointer_name}.`,
				path: pointerPath,
			});
		}

		for (const skill of category.skills ?? []) {
			const vaultSkillPath = joinPath(input.vaultDir, skill.vault_path);
			const vaultFile = Bun.file(vaultSkillPath);
			if (!(await vaultFile.exists())) {
				issues.push({
					code: "missing_vault_skill",
					message: `Vault skill missing for ${skill.name}.`,
					path: vaultSkillPath,
				});
				continue;
			}

			const content = await vaultFile.text();
			const checksum = hashContent(content);
			if (checksum !== skill.checksum_sha256) {
				issues.push({
					code: "checksum_mismatch",
					message: `Checksum mismatch for ${skill.name}.`,
					path: vaultSkillPath,
				});
			}
		}
	}

	return {
		ok: issues.length === 0,
		issues,
	};
}

export async function installSkillPointerArtifacts(
	options: InstallSkillPointerOptions,
): Promise<InstallSkillPointerResult> {
	const nowMs = options.nowMs ?? Date.now();
	const discovered = await discoverTemplateSkills(
		options.templateSkillsDir,
		options.vaultDir,
	);
	if (discovered.length === 0) {
		throw new Error("No template skills found for SkillPointer installation.");
	}

	const index = buildPointerIndex({
		nowMs,
		sourceRoot: options.templateSkillsDir,
		vaultDir: options.vaultDir,
		discovered,
		releaseTrainId: options.releaseTrainId ?? "local-dev",
		sourceContractSha: options.sourceContractSha ?? "",
	});

	const indexPath = joinPath(
		options.activeSkillsDir,
		POINTER_INDEX_DIR,
		POINTER_INDEX_FILE,
	);
	let fileWrites = 0;

	if (!options.dryRun) {
		await ensureDirectory(options.activeSkillsDir);
		await ensureDirectory(options.vaultDir);

		for (const skill of discovered) {
			fileWrites += await copyDir(skill.sourceDir, skill.vaultDir);
		}

		for (const category of index.categories) {
			const pointerSkillPath = joinPath(
				options.activeSkillsDir,
				category.pointer_path,
			);
			const pointerDir = pointerSkillPath.replace(/[\\/][^\\/]+$/, "");
			await ensureDirectory(pointerDir);

			const vaultCategoryDir = joinPath(options.vaultDir, category.category);
			const body = buildPointerSkillBody({
				category: category.category,
				vaultCategoryDir,
				skills: category.skills,
			});
			await Bun.write(pointerSkillPath, body);
			fileWrites += 1;
		}

		await ensureDirectory(joinPath(options.activeSkillsDir, POINTER_INDEX_DIR));
		await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
		fileWrites += 1;

		const integrity = await validateSkillPointerIndex({
			indexPath,
			activeSkillsDir: options.activeSkillsDir,
			vaultDir: options.vaultDir,
		});
		if (!integrity.ok) {
			const message = integrity.issues
				.map((issue) => `${issue.code}: ${issue.message}`)
				.join("; ");
			throw new Error(`SkillPointer integrity check failed: ${message}`);
		}
	} else {
		for (const skill of discovered) {
			const fileCount = await listFilesRecursively(skill.sourceDir);
			fileWrites += fileCount.length;
		}
		fileWrites += index.pointer_count + 1;
	}

	return {
		applied: !options.dryRun,
		fileWrites,
		indexPath,
		index,
	};
}

export async function rebuildSkillPointerArtifacts(options: {
	activeSkillsDir: string;
	vaultDir: string;
	nowMs?: number;
}): Promise<InstallSkillPointerResult> {
	const nowMs = options.nowMs ?? Date.now();
	const discovered = await discoverVaultSkills(options.vaultDir);
	if (discovered.length === 0) {
		throw new Error(
			"Vault does not contain skill bodies to rebuild SkillPointer index.",
		);
	}

	const index = buildPointerIndex({
		nowMs,
		sourceRoot: options.vaultDir,
		vaultDir: options.vaultDir,
		discovered,
		releaseTrainId: "rebuild-local",
		sourceContractSha: "",
	});

	const indexPath = joinPath(
		options.activeSkillsDir,
		POINTER_INDEX_DIR,
		POINTER_INDEX_FILE,
	);
	let fileWrites = 0;

	await ensureDirectory(options.activeSkillsDir);

	for (const category of index.categories) {
		const pointerSkillPath = joinPath(
			options.activeSkillsDir,
			category.pointer_path,
		);
		const pointerDir = pointerSkillPath.replace(/[\\/][^\\/]+$/, "");
		await ensureDirectory(pointerDir);

		const vaultCategoryDir = joinPath(options.vaultDir, category.category);
		const body = buildPointerSkillBody({
			category: category.category,
			vaultCategoryDir,
			skills: category.skills,
		});
		await Bun.write(pointerSkillPath, body);
		fileWrites += 1;
	}

	await ensureDirectory(joinPath(options.activeSkillsDir, POINTER_INDEX_DIR));
	await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
	fileWrites += 1;

	const integrity = await validateSkillPointerIndex({
		indexPath,
		activeSkillsDir: options.activeSkillsDir,
		vaultDir: options.vaultDir,
	});
	if (!integrity.ok) {
		const message = integrity.issues
			.map((issue) => `${issue.code}: ${issue.message}`)
			.join("; ");
		throw new Error(`SkillPointer rebuild integrity check failed: ${message}`);
	}

	return {
		applied: true,
		fileWrites,
		indexPath,
		index,
	};
}
