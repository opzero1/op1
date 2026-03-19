import type { RawParsedEdit } from "./types.js";

function stripPrefix(value: string): string {
	if (value === "/dev/null") return value;
	return value.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text: string): RawParsedEdit[] {
	if (!/^---\s/m.test(text) || !/^\+\+\+\s/m.test(text) || !/^@@/m.test(text)) {
		return [];
	}

	const oldPath = stripPrefix(
		text.match(/^---\s+([^\n]+)/m)?.[1]?.trim() ?? "",
	);
	const newPath = stripPrefix(
		text.match(/^\+\+\+\s+([^\n]+)/m)?.[1]?.trim() ?? "",
	);
	const operation =
		oldPath === "/dev/null"
			? "create"
			: newPath === "/dev/null"
				? "delete"
				: oldPath !== newPath
					? "rename"
					: "update";

	return [
		{
			sourceFormat: "unified-diff",
			path: newPath === "/dev/null" ? oldPath : newPath,
			previousPath: operation === "rename" ? oldPath : undefined,
			operation,
			rawText: text,
		},
	];
}
