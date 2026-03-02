const HASH_LENGTH = 8;

const HASH_ANCHOR_PATTERN = /^(\d+)#([0-9a-f]{8})$/;

export type HashAnchorErrorCode =
	| "anchor_format_invalid"
	| "anchor_line_out_of_range"
	| "anchor_hash_mismatch"
	| "anchor_stale_line"
	| "anchor_partial_conflict";

export interface HashAnchor {
	raw: string;
	line: number;
	hash: string;
}

export interface HashAnchorContext {
	previous?: string;
	next?: string;
}

export interface HashAnchorValidationInput {
	anchor: string;
	lineContent: string;
	lineNumber: number;
	lineCount: number;
	context?: HashAnchorContext;
	staleLine?: boolean;
	partialConflict?: boolean;
}

export interface HashAnchorValidationSuccess {
	ok: true;
	anchor: HashAnchor;
}

export interface HashAnchorValidationFailure {
	ok: false;
	code: HashAnchorErrorCode;
	message: string;
}

export type HashAnchorValidationResult =
	| HashAnchorValidationSuccess
	| HashAnchorValidationFailure;

function normalizeContent(value: string | undefined): string {
	if (!value) return "";
	return value.replace(/\r\n/g, "\n");
}

function hashAnchorPayload(
	lineNumber: number,
	lineContent: string,
	context?: HashAnchorContext,
): string {
	return [
		String(lineNumber),
		normalizeContent(context?.previous),
		normalizeContent(lineContent),
		normalizeContent(context?.next),
	].join("\n");
}

function shortHash(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex").slice(0, HASH_LENGTH);
}

export function parseHashAnchor(raw: string): HashAnchor | null {
	const match = raw.trim().match(HASH_ANCHOR_PATTERN);
	if (!match) return null;

	const line = Number.parseInt(match[1] || "", 10);
	const hash = (match[2] || "").toLowerCase();
	if (!Number.isFinite(line) || line < 1) return null;

	return {
		raw: raw.trim(),
		line,
		hash,
	};
}

export function buildHashAnchor(
	lineNumber: number,
	lineContent: string,
	context?: HashAnchorContext,
): string {
	const payload = hashAnchorPayload(lineNumber, lineContent, context);
	return `${lineNumber}#${shortHash(payload)}`;
}

export function validateHashAnchor(
	input: HashAnchorValidationInput,
): HashAnchorValidationResult {
	const anchor = parseHashAnchor(input.anchor);
	if (!anchor) {
		return {
			ok: false,
			code: "anchor_format_invalid",
			message: `Invalid hash anchor format: ${input.anchor}`,
		};
	}

	if (anchor.line !== input.lineNumber) {
		return {
			ok: false,
			code: "anchor_stale_line",
			message: `Anchor line mismatch: expected ${input.lineNumber}, got ${anchor.line}`,
		};
	}

	if (anchor.line < 1 || anchor.line > input.lineCount) {
		return {
			ok: false,
			code: "anchor_line_out_of_range",
			message: `Anchor line ${anchor.line} is outside file range 1..${input.lineCount}`,
		};
	}

	if (input.staleLine) {
		return {
			ok: false,
			code: "anchor_stale_line",
			message: `Anchor stale-line conflict detected for line ${anchor.line}`,
		};
	}

	if (input.partialConflict) {
		return {
			ok: false,
			code: "anchor_partial_conflict",
			message: `Anchor partial conflict detected for line ${anchor.line}`,
		};
	}

	const expected = buildHashAnchor(
		input.lineNumber,
		input.lineContent,
		input.context,
	);
	if (expected !== anchor.raw.toLowerCase()) {
		return {
			ok: false,
			code: "anchor_hash_mismatch",
			message: `Anchor hash mismatch for line ${anchor.line}`,
		};
	}

	return {
		ok: true,
		anchor,
	};
}

export { HASH_ANCHOR_PATTERN, HASH_LENGTH };
