import { parseFencedFileBlocks } from "./fenced.js";
import { parsePatchText } from "./patch-text.js";
import { parseSearchReplaceBlocks } from "./search-replace.js";
import { parseStructuredEdits } from "./structured.js";
import type { RawParsedEdit } from "./types.js";
import { parseUnifiedDiff } from "./unified-diff.js";

export type { RawParsedEdit } from "./types.js";

export function parseEditFormats(text: string): RawParsedEdit[] {
	return [
		...parsePatchText(text),
		...parseSearchReplaceBlocks(text),
		...parseUnifiedDiff(text),
		...parseFencedFileBlocks(text),
		...parseStructuredEdits(text),
	];
}
