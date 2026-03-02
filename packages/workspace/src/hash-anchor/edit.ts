import { resolve } from "../bun-compat.js";
import { detectHashlineBoundaryViolation } from "../hooks/edit-safety.js";
import {
	type HashAnchorErrorCode,
	parseHashAnchor,
	validateHashAnchor,
} from "./contract.js";

type HashAnchoredEditErrorCode =
	| HashAnchorErrorCode
	| "hash_anchor_feature_disabled"
	| "hash_anchor_file_not_found"
	| "hash_anchor_file_is_directory"
	| "hash_anchor_empty"
	| "hash_anchor_duplicate"
	| "hash_anchor_non_contiguous"
	| "hash_anchor_boundary_violation"
	| "hash_anchor_write_failed";

interface HashAnchoredEditInput {
	filePath: string;
	anchors: string[];
	replacement: string;
}

interface HashAnchoredEditContext {
	directory: string;
	enabled: boolean;
}

interface HashAnchoredEditSuccess {
	ok: true;
	filePath: string;
	applied: {
		startLine: number;
		endLine: number;
		replacedLineCount: number;
		newLineCount: number;
	};
}

interface HashAnchoredEditFailure {
	ok: false;
	code: HashAnchoredEditErrorCode;
	message: string;
	filePath?: string;
	details?: Record<string, unknown>;
}

type HashAnchoredEditResult = HashAnchoredEditSuccess | HashAnchoredEditFailure;

interface ParsedAnchor {
	raw: string;
	line: number;
}

function normalizeNewlines(input: string): string {
	return input.replace(/\r\n/g, "\n");
}

function splitLinesPreservingTerminalEmpty(content: string): string[] {
	if (content.length === 0) return [""];
	return content.split("\n");
}

function fail(
	code: HashAnchoredEditErrorCode,
	message: string,
	extra?: Partial<Pick<HashAnchoredEditFailure, "filePath" | "details">>,
): HashAnchoredEditFailure {
	return {
		ok: false,
		code,
		message,
		...extra,
	};
}

function parseAndValidateAnchorSet(
	anchors: string[],
):
	| { ok: true; anchors: ParsedAnchor[] }
	| { ok: false; error: HashAnchoredEditFailure } {
	if (anchors.length === 0) {
		return {
			ok: false,
			error: fail("hash_anchor_empty", "At least one hash anchor is required."),
		};
	}

	const parsed: ParsedAnchor[] = [];
	for (const rawAnchor of anchors) {
		const anchor = parseHashAnchor(rawAnchor);
		if (!anchor) {
			return {
				ok: false,
				error: fail(
					"anchor_format_invalid",
					`Invalid hash anchor format: ${rawAnchor}`,
				),
			};
		}

		parsed.push({
			raw: anchor.raw,
			line: anchor.line,
		});
	}

	const sorted = [...parsed].sort((a, b) => a.line - b.line);
	const seen = new Set<number>();
	for (let index = 0; index < sorted.length; index += 1) {
		const current = sorted[index];
		if (seen.has(current.line)) {
			return {
				ok: false,
				error: fail(
					"hash_anchor_duplicate",
					`Duplicate hash anchor line detected: ${current.line}`,
					{ details: { line: current.line } },
				),
			};
		}
		seen.add(current.line);

		const previous = sorted[index - 1];
		if (previous && current.line !== previous.line + 1) {
			return {
				ok: false,
				error: fail(
					"hash_anchor_non_contiguous",
					`Hash anchors must target one contiguous line range. Gap detected between ${previous.line} and ${current.line}.`,
					{
						details: {
							previousLine: previous.line,
							currentLine: current.line,
						},
					},
				),
			};
		}
	}

	return {
		ok: true,
		anchors: sorted,
	};
}

function lineContext(
	lines: string[],
	lineNumber: number,
): { previous?: string; next?: string } {
	return {
		previous: lines[lineNumber - 2],
		next: lines[lineNumber],
	};
}

function mapValidationError(error: {
	code: HashAnchorErrorCode;
	message: string;
}): HashAnchoredEditFailure {
	return fail(error.code, error.message);
}

function withEolPolicy(text: string, hadTrailingNewline: boolean): string {
	if (hadTrailingNewline && !text.endsWith("\n")) {
		return `${text}\n`;
	}
	if (!hadTrailingNewline && text.endsWith("\n")) {
		return text.slice(0, -1);
	}
	return text;
}

export async function executeHashAnchoredEdit(
	input: HashAnchoredEditInput,
	context: HashAnchoredEditContext,
): Promise<HashAnchoredEditResult> {
	if (!context.enabled) {
		return fail(
			"hash_anchor_feature_disabled",
			"hash_anchored_edit is disabled. Enable features.hashAnchoredEdit in workspace.json.",
		);
	}

	const absolutePath = resolve(context.directory, input.filePath);
	const target = Bun.file(absolutePath);
	if (!(await target.exists())) {
		return fail(
			"hash_anchor_file_not_found",
			`Target file not found: ${input.filePath}`,
			{ filePath: input.filePath },
		);
	}

	const stats = await target.stat();
	if (stats.isDirectory()) {
		return fail(
			"hash_anchor_file_is_directory",
			`Target path is a directory, expected a file: ${input.filePath}`,
			{ filePath: input.filePath },
		);
	}

	const parsedAnchors = parseAndValidateAnchorSet(input.anchors);
	if (!parsedAnchors.ok) {
		return {
			...parsedAnchors.error,
			filePath: input.filePath,
		};
	}

	const original = normalizeNewlines(await target.text());
	const hadTrailingNewline = original.endsWith("\n");
	const originalLines = splitLinesPreservingTerminalEmpty(original);

	const results = parsedAnchors.anchors.map((anchor) => {
		const lineContent = originalLines[anchor.line - 1] ?? "";
		const validation = validateHashAnchor({
			anchor: anchor.raw,
			lineNumber: anchor.line,
			lineCount: originalLines.length,
			lineContent,
			context: lineContext(originalLines, anchor.line),
		});

		return {
			anchor,
			validation,
		};
	});

	const failures = results.filter((entry) => !entry.validation.ok);
	if (failures.length > 0) {
		if (failures.length < results.length) {
			return fail(
				"anchor_partial_conflict",
				"Anchor partial conflict detected: some anchors matched while others failed.",
				{
					filePath: input.filePath,
					details: {
						failedLines: failures.map((entry) => entry.anchor.line),
					},
				},
			);
		}

		const first = failures[0];
		if (!first.validation.ok) {
			return {
				...mapValidationError(first.validation),
				filePath: input.filePath,
			};
		}
	}

	const startLine = parsedAnchors.anchors[0]?.line ?? 1;
	const endLine =
		parsedAnchors.anchors[parsedAnchors.anchors.length - 1]?.line ?? 1;
	const oldString = originalLines.slice(startLine - 1, endLine).join("\n");

	const boundaryViolation = detectHashlineBoundaryViolation(
		oldString,
		input.replacement,
	);
	if (boundaryViolation) {
		return fail("hash_anchor_boundary_violation", boundaryViolation, {
			filePath: input.filePath,
		});
	}

	const replacementLines = splitLinesPreservingTerminalEmpty(
		normalizeNewlines(input.replacement),
	);
	const nextLines = [
		...originalLines.slice(0, startLine - 1),
		...replacementLines,
		...originalLines.slice(endLine),
	];
	const nextContent = withEolPolicy(nextLines.join("\n"), hadTrailingNewline);

	try {
		await Bun.write(target, nextContent);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fail(
			"hash_anchor_write_failed",
			`Failed to write file: ${message}`,
			{
				filePath: input.filePath,
			},
		);
	}

	return {
		ok: true,
		filePath: input.filePath,
		applied: {
			startLine,
			endLine,
			replacedLineCount: endLine - startLine + 1,
			newLineCount: replacementLines.length,
		},
	};
}

export type {
	HashAnchoredEditContext,
	HashAnchoredEditErrorCode,
	HashAnchoredEditFailure,
	HashAnchoredEditInput,
	HashAnchoredEditResult,
	HashAnchoredEditSuccess,
};
