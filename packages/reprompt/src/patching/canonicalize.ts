import type { CanonicalPatchCandidate, RawParsedEdit } from "./shared.js";

export interface CanonicalizeResult {
	candidates: CanonicalPatchCandidate[];
	diagnostics: string[];
}

export function canonicalizeParsedEdits(
	edits: RawParsedEdit[],
): CanonicalizeResult {
	const candidates: CanonicalPatchCandidate[] = [];
	const diagnostics: string[] = [];

	for (const edit of edits) {
		if (!edit.path) {
			diagnostics.push(`missing path for ${edit.sourceFormat} edit`);
			continue;
		}

		if (edit.sourceFormat === "search-replace" && edit.searchText) {
			candidates.push({
				path: edit.path,
				operation: edit.operation ?? "update",
				anchors: [{ exactText: edit.searchText }],
				replacement: edit.replacement ?? "",
				sourceFormat: edit.sourceFormat,
				searchText: edit.searchText,
				rawText: edit.rawText,
			});
			continue;
		}

		candidates.push({
			path: edit.path,
			operation: edit.operation ?? "update",
			previousPath: edit.previousPath,
			anchors: [],
			replacement: edit.replacement,
			content: edit.content,
			sourceFormat: edit.sourceFormat,
			searchText: edit.searchText,
			rawText: edit.rawText,
		});
	}

	return { candidates, diagnostics };
}
