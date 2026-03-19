import type { RawParsedEdit } from "./types.js";

export function parseSearchReplaceBlocks(text: string): RawParsedEdit[] {
	const matches = [
		...text.matchAll(
			/<<<<<<<\s*SEARCH(?:\s+path=([^\n]+))?\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>\s*REPLACE/g,
		),
	];

	return matches.flatMap((match) => {
		const path = match[1]?.trim();
		if (!path) return [];
		return [
			{
				sourceFormat: "search-replace" as const,
				path,
				operation: "update" as const,
				searchText: match[2] ?? "",
				replacement: match[3] ?? "",
				rawText: match[0],
			},
		];
	});
}
