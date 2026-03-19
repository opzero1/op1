import { resolve } from "node:path";
import type {
	PatchCandidate,
	PatchOperation,
	PatchValidationResult,
} from "../types.js";

export type ParsedEditFormat =
	| "fenced"
	| "search-replace"
	| "unified-diff"
	| "patch-text"
	| "structured";

export interface RawParsedEdit {
	sourceFormat: ParsedEditFormat;
	path?: string;
	previousPath?: string;
	operation?: PatchOperation;
	searchText?: string;
	replacement?: string;
	content?: string;
	rawText: string;
}

export interface CanonicalPatchCandidate extends PatchCandidate {
	sourceFormat: ParsedEditFormat;
	searchText?: string;
	rawText?: string;
}

export interface ValidatedPatchCandidate {
	candidate: CanonicalPatchCandidate;
	absolutePath: string;
	absolutePreviousPath?: string;
	validation: PatchValidationResult;
}

export function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function splitLines(value: string): string[] {
	if (value.length === 0) return [""];
	return normalizeNewlines(value).split("\n");
}

export function isPathWithinRoot(root: string, targetPath: string): boolean {
	const absoluteRoot = resolve(root);
	const absoluteTarget = resolve(targetPath);
	return (
		absoluteTarget === absoluteRoot ||
		absoluteTarget.startsWith(`${absoluteRoot}/`)
	);
}

export function detectBoundaryViolation(
	oldString: string,
	newString: string,
): string | null {
	if (!oldString) return null;

	const oldLines = normalizeNewlines(oldString).split("\n");
	const newLines = normalizeNewlines(newString).split("\n");
	const countMatches = (lines: string[], pattern: RegExp) =>
		lines.filter((line) => pattern.test(line.trim())).length;

	if (countMatches(oldLines, /^#{1,6}\s+/) > 1) {
		return "structural edit spans multiple heading anchors";
	}
	if (
		countMatches(oldLines, /^```/) % 2 !== 0 ||
		countMatches(newLines, /^```/) % 2 !== 0
	) {
		return "unbalanced code fences detected";
	}
	if (
		countMatches(oldLines, /^---$/) % 2 !== 0 ||
		countMatches(newLines, /^---$/) % 2 !== 0
	) {
		return "unbalanced frontmatter fences detected";
	}

	return null;
}

export function buildHashAnchor(
	lineNumber: number,
	lineContent: string,
	context?: { previous?: string; next?: string },
): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(
		[
			String(lineNumber),
			context?.previous ?? "",
			lineContent,
			context?.next ?? "",
		].join("\n"),
	);
	return `${lineNumber}#${hasher.digest("hex").slice(0, 8)}`;
}
