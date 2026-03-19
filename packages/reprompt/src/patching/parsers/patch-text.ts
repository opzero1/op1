import type { PatchOperation } from "../../types.js";
import type { RawParsedEdit } from "./types.js";

const HEADER_PATTERN = /^\*\*\*\s+(Add|Update|Delete) File:\s+(.+)$/gm;

function operationForHeader(value: string): PatchOperation {
	if (value === "Add") return "create";
	if (value === "Delete") return "delete";
	return "update";
}

export function parsePatchText(text: string): RawParsedEdit[] {
	if (!text.includes("*** Begin Patch")) return [];

	const matches = [...text.matchAll(HEADER_PATTERN)];
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = matches[index + 1]?.index ?? text.indexOf("*** End Patch");
		const section = text.slice(start, end === -1 ? undefined : end).trim();
		const moveTo = section.match(/^\*\*\*\s+Move to:\s+(.+)$/m)?.[1]?.trim();
		return {
			sourceFormat: "patch-text" as const,
			path: moveTo ?? match[2]?.trim(),
			previousPath: moveTo ? match[2]?.trim() : undefined,
			operation: moveTo ? "rename" : operationForHeader(match[1] ?? "Update"),
			rawText: section,
		};
	});
}
