import { join } from "node:path";
import { redactText } from "../redaction.js";
import type { EvidenceKind, EvidenceSlice } from "../types.js";
import {
	clamp,
	estimateTokens,
	hashText,
	readTextFile,
	splitLines,
	truncateText,
	withLineNumbers,
} from "./shared.js";

interface SliceRequestBase {
	path: string;
	reason: string;
	contextBefore?: number;
	contextAfter?: number;
	maxChars?: number;
}

export interface FileSliceRequest extends SliceRequestBase {
	kind: "file";
	line?: number;
}

export interface SymbolSliceRequest extends SliceRequestBase {
	kind: "symbol";
	symbol: string;
}

export interface GrepSliceRequest extends SliceRequestBase {
	kind: "grep";
	pattern: string;
	maxMatches?: number;
}

export interface DiagnosticSliceRequest extends SliceRequestBase {
	kind: "diagnostic";
	line: number;
	message: string;
}

export interface RecentEditSliceRequest extends SliceRequestBase {
	kind: "recent-edit";
	line?: number;
	message?: string;
}

export interface FailureSliceRequest extends SliceRequestBase {
	kind: "failure";
	line?: number;
	message: string;
}

export type SliceRequest =
	| FileSliceRequest
	| SymbolSliceRequest
	| GrepSliceRequest
	| DiagnosticSliceRequest
	| RecentEditSliceRequest
	| FailureSliceRequest;

export interface CollectSliceOptions {
	defaultContextBefore?: number;
	defaultContextAfter?: number;
	defaultMaxChars?: number;
}

function evidenceKindForRequest(kind: SliceRequest["kind"]): EvidenceKind {
	if (kind === "diagnostic") return "diagnostic";
	if (kind === "recent-edit") return "diff";
	if (kind === "grep") return "grep-hit";
	return "file-slice";
}

function buildSlice(input: {
	kind: EvidenceKind;
	path: string;
	reason: string;
	startLine: number;
	endLine: number;
	excerpt: string;
	symbol?: string;
}): EvidenceSlice {
	const excerpt = redactText(input.excerpt).trim();
	const provenance = `${input.path}:${input.startLine}-${input.endLine}`;
	return {
		id: hashText(
			JSON.stringify({
				kind: input.kind,
				path: input.path,
				startLine: input.startLine,
				endLine: input.endLine,
				reason: input.reason,
			}),
		),
		kind: input.kind,
		path: input.path,
		symbol: input.symbol,
		startLine: input.startLine,
		endLine: input.endLine,
		reason: input.reason,
		excerpt,
		tokenCount: estimateTokens(excerpt),
		provenance,
		redacted: excerpt !== input.excerpt.trim(),
	};
}

function resolveWindow(input: {
	lines: string[];
	line: number;
	contextBefore: number;
	contextAfter: number;
	maxChars: number;
}): { excerpt: string; startLine: number; endLine: number } {
	const index = clamp(input.line - 1, 0, Math.max(input.lines.length - 1, 0));
	const startIndex = clamp(index - input.contextBefore, 0, input.lines.length);
	const endIndex = clamp(index + input.contextAfter + 1, 0, input.lines.length);
	const excerpt = truncateText(
		withLineNumbers(input.lines.slice(startIndex, endIndex), startIndex + 1),
		input.maxChars,
	);
	return {
		excerpt,
		startLine: startIndex + 1,
		endLine: Math.max(startIndex + 1, endIndex),
	};
}

function findSymbolLine(lines: string[], symbol: string): number {
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = [
		new RegExp(`\\bfunction\\s+${escaped}\\b`),
		new RegExp(`\\bclass\\s+${escaped}\\b`),
		new RegExp(`\\bdef\\s+${escaped}\\b`),
		new RegExp(`\\b${escaped}\\b`),
	];

	for (let index = 0; index < lines.length; index += 1) {
		for (const pattern of patterns) {
			if (pattern.test(lines[index] ?? "")) {
				return index + 1;
			}
		}
	}

	return 1;
}

export async function collectEvidenceSlices(
	workspaceRoot: string,
	requests: SliceRequest[],
	options: CollectSliceOptions = {},
): Promise<EvidenceSlice[]> {
	const defaultContextBefore = options.defaultContextBefore ?? 12;
	const defaultContextAfter = options.defaultContextAfter ?? 12;
	const defaultMaxChars = options.defaultMaxChars ?? 2_400;
	const slices: EvidenceSlice[] = [];

	for (const request of requests) {
		const content = await readTextFile(join(workspaceRoot, request.path));
		if (!content) continue;

		const lines = splitLines(content);
		const contextBefore = request.contextBefore ?? defaultContextBefore;
		const contextAfter = request.contextAfter ?? defaultContextAfter;
		const maxChars = request.maxChars ?? defaultMaxChars;

		if (request.kind === "grep") {
			const pattern = new RegExp(request.pattern, "i");
			let found = 0;
			for (let index = 0; index < lines.length; index += 1) {
				if (!pattern.test(lines[index] ?? "")) continue;
				const window = resolveWindow({
					lines,
					line: index + 1,
					contextBefore,
					contextAfter,
					maxChars,
				});
				slices.push(
					buildSlice({
						kind: evidenceKindForRequest(request.kind),
						path: request.path,
						reason: request.reason,
						startLine: window.startLine,
						endLine: window.endLine,
						excerpt: window.excerpt,
					}),
				);
				found += 1;
				if (found >= (request.maxMatches ?? 3)) break;
			}
			continue;
		}

		const line =
			request.kind === "symbol"
				? findSymbolLine(lines, request.symbol)
				: (request.line ?? 1);
		const window = resolveWindow({
			lines,
			line,
			contextBefore,
			contextAfter,
			maxChars,
		});
		const reason =
			request.kind === "diagnostic" || request.kind === "failure"
				? `${request.reason}: ${request.message}`
				: request.kind === "recent-edit" && request.message
					? `${request.reason}: ${request.message}`
					: request.reason;

		slices.push(
			buildSlice({
				kind: evidenceKindForRequest(request.kind),
				path: request.path,
				reason,
				startLine: window.startLine,
				endLine: window.endLine,
				excerpt: window.excerpt,
				symbol: request.kind === "symbol" ? request.symbol : undefined,
			}),
		);
	}

	const unique = new Map<string, EvidenceSlice>();
	for (const slice of slices) {
		unique.set(slice.id, slice);
	}

	return [...unique.values()].sort((left, right) => {
		if (left.path !== right.path) {
			return (left.path ?? "").localeCompare(right.path ?? "");
		}
		return (left.startLine ?? 0) - (right.startLine ?? 0);
	});
}
