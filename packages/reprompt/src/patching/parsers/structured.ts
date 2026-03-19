import type { RawParsedEdit } from "./types.js";

export function parseStructuredEdits(text: string): RawParsedEdit[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}

	const items = Array.isArray(parsed) ? parsed : [parsed];
	return items.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const value = item as Record<string, unknown>;
		const path = typeof value.path === "string" ? value.path : undefined;
		if (!path) return [];
		const operation =
			typeof value.operation === "string"
				? (value.operation as RawParsedEdit["operation"])
				: "update";
		return [
			{
				sourceFormat: "structured" as const,
				path,
				previousPath:
					typeof value.previousPath === "string"
						? value.previousPath
						: undefined,
				operation,
				searchText: typeof value.search === "string" ? value.search : undefined,
				replacement:
					typeof value.replacement === "string" ? value.replacement : undefined,
				content: typeof value.content === "string" ? value.content : undefined,
				rawText: JSON.stringify(item),
			},
		];
	});
}
