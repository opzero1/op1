import type { RawParsedEdit } from "./types.js";

function extractPath(
	header: string,
	body: string,
): { path?: string; content: string } {
	const pathMatch = header.match(/path=([^\s`]+)/i);
	if (pathMatch?.[1]) {
		return { path: pathMatch[1], content: body };
	}

	const lines = body.split("\n");
	const first = lines[0]?.match(/^(?:FILE|PATH):\s*(.+)$/i)?.[1];
	if (first) {
		return { path: first.trim(), content: lines.slice(1).join("\n") };
	}

	return { content: body };
}

export function parseFencedFileBlocks(text: string): RawParsedEdit[] {
	const matches = [...text.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)];
	return matches.flatMap((match) => {
		const body = match[2] ?? "";
		const parsed = extractPath(match[1] ?? "", body);
		if (!parsed.path) return [];
		return [
			{
				sourceFormat: "fenced" as const,
				path: parsed.path,
				operation: "update" as const,
				replacement: parsed.content,
				rawText: match[0],
			},
		];
	});
}
