import { join } from "../bun-compat.js";

export interface SkillPointerIntegrityIssue {
	code: string;
	message: string;
	path?: string;
}

export interface SkillPointerIntegrityResult {
	ok: boolean;
	issues: SkillPointerIntegrityIssue[];
}

export interface SkillPointerResolution {
	source: "vault" | "legacy" | "external" | "missing";
	content?: string;
	path?: string;
	warning?: string;
	code?:
		| "pointer_resolved"
		| "pointer_required_unavailable"
		| "pointer_integrity_mismatch"
		| "pointer_unavailable_fallback";
}

interface SkillPointerIndexSkill {
	name: string;
	checksum_sha256: string;
	vault_path: string;
}

interface SkillPointerIndexCategory {
	category: string;
	skills: SkillPointerIndexSkill[];
}

interface SkillPointerIndex {
	version: number;
	vault_root: string;
	categories: SkillPointerIndexCategory[];
}

interface SkillPointerResolverOptions {
	enabled: boolean;
	skillsRoot: string;
	externalSkillRoots?: string[];
	mode?: "fallback" | "exclusive";
}

const INDEX_DIR = ".skillpointer";
const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;

function hashContent(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

function normalizeSlash(value: string): string {
	return value.replace(/\\+/g, "/");
}

function flattenIndexSkills(
	index: SkillPointerIndex,
): SkillPointerIndexSkill[] {
	const skills: SkillPointerIndexSkill[] = [];
	for (const category of index.categories) {
		for (const skill of category.skills) {
			skills.push(skill);
		}
	}
	return skills;
}

export function createSkillPointerResolver(
	options: SkillPointerResolverOptions,
) {
	const indexPath = join(options.skillsRoot, INDEX_DIR, INDEX_FILE);
	const externalSkillRoots =
		options.externalSkillRoots?.filter((entry) => entry.trim().length > 0) ??
		[];

	async function readIndex(): Promise<SkillPointerIndex | null> {
		if (!options.enabled) return null;
		const file = Bun.file(indexPath);
		if (!(await file.exists())) return null;

		try {
			const parsed = (await file.json()) as SkillPointerIndex;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!Array.isArray(parsed.categories)
			) {
				return null;
			}
			return parsed;
		} catch {
			return null;
		}
	}

	async function validateIndex(): Promise<SkillPointerIntegrityResult> {
		if (!options.enabled) {
			return { ok: true, issues: [] };
		}

		const issues: SkillPointerIntegrityIssue[] = [];
		const file = Bun.file(indexPath);
		if (!(await file.exists())) {
			issues.push({
				code: "missing_index",
				message: "SkillPointer index file is missing.",
				path: indexPath,
			});
			return { ok: false, issues };
		}

		const index = await readIndex();
		if (!index) {
			issues.push({
				code: "malformed_index",
				message: "SkillPointer index could not be parsed.",
				path: indexPath,
			});
			return { ok: false, issues };
		}

		if (index.version !== INDEX_VERSION) {
			issues.push({
				code: "unsupported_version",
				message: `Expected SkillPointer index version ${INDEX_VERSION} but found ${index.version}.`,
				path: indexPath,
			});
		}

		for (const skill of flattenIndexSkills(index)) {
			const vaultPath = join(
				index.vault_root,
				normalizeSlash(skill.vault_path),
			);
			if (!(await Bun.file(vaultPath).exists())) {
				issues.push({
					code: "missing_vault_skill",
					message: `Vault skill body missing for ${skill.name}.`,
					path: vaultPath,
				});
			}
		}

		return {
			ok: issues.length === 0,
			issues,
		};
	}

	async function resolveSkillBody(
		skillName: string,
	): Promise<SkillPointerResolution> {
		const mode = options.mode === "exclusive" ? "exclusive" : "fallback";
		const exclusive = options.enabled && mode === "exclusive";
		const normalizedName = skillName.trim();
		if (!normalizedName) {
			return {
				source: "missing",
				warning: "Skill name is required.",
				code: "pointer_required_unavailable",
			};
		}

		const index = await readIndex();
		if (index) {
			const entry = flattenIndexSkills(index).find(
				(skill) => skill.name === normalizedName,
			);
			if (entry) {
				const vaultPath = join(
					index.vault_root,
					normalizeSlash(entry.vault_path),
				);
				const vaultFile = Bun.file(vaultPath);
				if (await vaultFile.exists()) {
					const content = await vaultFile.text();
					const checksum = hashContent(content);
					if (checksum === entry.checksum_sha256) {
						return {
							source: "vault",
							content,
							path: vaultPath,
							code: "pointer_resolved",
						};
					}
					if (exclusive) {
						return {
							source: "missing",
							warning: `SkillPointer exclusive mode denied fallback for '${normalizedName}' due to checksum mismatch.`,
							code: "pointer_integrity_mismatch",
						};
					}
				}
				if (exclusive) {
					return {
						source: "missing",
						warning: `SkillPointer exclusive mode denied fallback for '${normalizedName}' because pointer vault body is unavailable.`,
						code: "pointer_required_unavailable",
					};
				}
			}
		}

		if (exclusive) {
			return {
				source: "missing",
				warning: `SkillPointer exclusive mode denied fallback for '${normalizedName}' because no valid pointer entry was available.`,
				code: "pointer_required_unavailable",
			};
		}

		const legacyPath = join(options.skillsRoot, normalizedName, "SKILL.md");
		const legacyFile = Bun.file(legacyPath);
		if (await legacyFile.exists()) {
			return {
				source: "legacy",
				content: await legacyFile.text(),
				path: legacyPath,
				warning: "SkillPointer fallback: resolved legacy skill body.",
				code: "pointer_unavailable_fallback",
			};
		}

		for (const root of externalSkillRoots) {
			const projectPath = join(root, "skills", normalizedName, "SKILL.md");
			const projectFile = Bun.file(projectPath);
			if (await projectFile.exists()) {
				return {
					source: "external",
					content: await projectFile.text(),
					path: projectPath,
					warning:
						"SkillPointer fallback: resolved Claude-compatible external skill body.",
					code: "pointer_unavailable_fallback",
				};
			}

			const legacyExternalPath = join(
				root,
				"skill",
				normalizedName,
				"SKILL.md",
			);
			const legacyExternalFile = Bun.file(legacyExternalPath);
			if (await legacyExternalFile.exists()) {
				return {
					source: "external",
					content: await legacyExternalFile.text(),
					path: legacyExternalPath,
					warning:
						"SkillPointer fallback: resolved Claude-compatible external skill body.",
					code: "pointer_unavailable_fallback",
				};
			}
		}

		return {
			source: "missing",
			warning: `Skill '${normalizedName}' was not found in pointer vault or legacy directory.`,
			code: "pointer_required_unavailable",
		};
	}

	return {
		indexPath,
		readIndex,
		validateIndex,
		resolveSkillBody,
	};
}

export type SkillPointerResolver = ReturnType<
	typeof createSkillPointerResolver
>;
