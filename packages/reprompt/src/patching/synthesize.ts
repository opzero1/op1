import type { ValidatedPatchCandidate } from "./shared.js";
import { buildHashAnchor, splitLines } from "./shared.js";

export interface PatchExecutionPlan {
	strategy: "apply_patch" | "hash-anchor" | "manual";
	dryRunScore: number;
	diagnostics: string[];
	patchText?: string;
	hashAnchoredEdit?: {
		filePath: string;
		anchors: string[];
		replacement: string;
	};
}

function prefixPatchLines(content: string): string {
	return splitLines(content)
		.map((line) => `+${line}`)
		.join("\n");
}

function buildAddFilePatch(path: string, content: string): string {
	return `*** Begin Patch\n*** Add File: ${path}\n${prefixPatchLines(content)}\n*** End Patch`;
}

function buildDeleteFilePatch(path: string): string {
	return `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`;
}

function locateExactText(
	content: string,
	exactText: string,
): { start: number; end: number } | null {
	const index = content.indexOf(exactText);
	if (index === -1) return null;
	const before = content.slice(0, index).split("\n");
	const lines = splitLines(exactText);
	const start = before.length;
	return { start, end: start + lines.length - 1 };
}

export async function synthesizePatchPlan(
	validated: ValidatedPatchCandidate,
): Promise<PatchExecutionPlan> {
	if (!validated.validation.ok) {
		return {
			strategy: "manual",
			dryRunScore: 0,
			diagnostics: [validated.validation.message],
		};
	}

	const candidate = validated.candidate;
	if (candidate.sourceFormat === "patch-text") {
		return {
			strategy: "apply_patch",
			dryRunScore: 0.95,
			diagnostics: [],
			patchText: `*** Begin Patch\n${candidate.rawText ?? ""}\n*** End Patch`,
		};
	}

	if (
		candidate.sourceFormat === "search-replace" &&
		candidate.anchors[0]?.exactText
	) {
		const current = await Bun.file(validated.absolutePath).text();
		const range = locateExactText(current, candidate.anchors[0].exactText);
		if (!range) {
			return {
				strategy: "manual",
				dryRunScore: 0,
				diagnostics: [
					"search anchor could not be re-located for hash-anchor synthesis",
				],
			};
		}

		const lines = splitLines(current);
		const anchors: string[] = [];
		for (let line = range.start; line <= range.end; line += 1) {
			anchors.push(
				buildHashAnchor(line, lines[line - 1] ?? "", {
					previous: lines[line - 2],
					next: lines[line],
				}),
			);
		}

		return {
			strategy: "hash-anchor",
			dryRunScore: 0.9,
			diagnostics: [],
			hashAnchoredEdit: {
				filePath: candidate.path,
				anchors,
				replacement: candidate.replacement ?? "",
			},
		};
	}

	if (candidate.operation === "create") {
		return {
			strategy: "apply_patch",
			dryRunScore: 0.8,
			diagnostics: [],
			patchText: buildAddFilePatch(
				candidate.path,
				candidate.content ?? candidate.replacement ?? "",
			),
		};
	}

	if (candidate.operation === "delete") {
		return {
			strategy: "apply_patch",
			dryRunScore: 0.8,
			diagnostics: [],
			patchText: buildDeleteFilePatch(candidate.path),
		};
	}

	return {
		strategy: "manual",
		dryRunScore: 0,
		diagnostics: ["no safe execution strategy available for this candidate"],
	};
}
