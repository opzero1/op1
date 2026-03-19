import { resolve } from "node:path";
import type {
	PatchValidationFailureCode,
	PatchValidationResult,
} from "../types.js";
import {
	type CanonicalPatchCandidate,
	detectBoundaryViolation,
	isPathWithinRoot,
	type ValidatedPatchCandidate,
} from "./shared.js";

const GENERATED_PATTERNS = [
	/^dist\//,
	/^coverage\//,
	/\.min\./,
	/\.d\.ts$/,
	/^bun\.lock$/,
	/^package-lock\.json$/,
	/^pnpm-lock\.ya?ml$/,
	/^yarn\.lock$/,
] as const;

const BINARY_EXTENSIONS = new Set([
	".gif",
	".ico",
	".jpeg",
	".jpg",
	".pdf",
	".png",
	".tar",
	".tgz",
	".ttf",
	".woff",
	".woff2",
	".zip",
]);

function failure(
	reason: PatchValidationFailureCode,
	message: string,
	path?: string,
): PatchValidationResult {
	return {
		ok: false,
		reason,
		message,
		path,
		details: {},
	};
}

function isGeneratedPath(path: string): boolean {
	return GENERATED_PATTERNS.some((pattern) => pattern.test(path));
}

function isBinaryPath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return false;
	return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export async function validatePatchCandidate(
	workspaceRoot: string,
	candidate: CanonicalPatchCandidate,
): Promise<ValidatedPatchCandidate> {
	const absolutePath = resolve(workspaceRoot, candidate.path);
	const absolutePreviousPath = candidate.previousPath
		? resolve(workspaceRoot, candidate.previousPath)
		: undefined;

	if (!isPathWithinRoot(workspaceRoot, absolutePath)) {
		return {
			candidate,
			absolutePath,
			absolutePreviousPath,
			validation: failure(
				"out-of-root",
				"target path is outside the workspace root",
				candidate.path,
			),
		};
	}

	if (isGeneratedPath(candidate.path)) {
		return {
			candidate,
			absolutePath,
			absolutePreviousPath,
			validation: failure(
				"generated-target",
				"generated or lockfile target rejected",
				candidate.path,
			),
		};
	}

	if (isBinaryPath(candidate.path)) {
		return {
			candidate,
			absolutePath,
			absolutePreviousPath,
			validation: failure(
				"binary-target",
				"binary target rejected",
				candidate.path,
			),
		};
	}

	const file = Bun.file(absolutePath);
	const exists = await file.exists();

	if (candidate.operation === "create" && exists) {
		return {
			candidate,
			absolutePath,
			absolutePreviousPath,
			validation: failure(
				"create-update-mismatch",
				"create target already exists",
				candidate.path,
			),
		};
	}

	if (candidate.operation === "update" && !exists) {
		return {
			candidate,
			absolutePath,
			absolutePreviousPath,
			validation: failure(
				"create-update-mismatch",
				"update target does not exist",
				candidate.path,
			),
		};
	}

	if (
		candidate.operation === "rename" &&
		candidate.previousPath &&
		(await file.exists())
	) {
		return {
			candidate,
			absolutePath,
			absolutePreviousPath,
			validation: failure(
				"rename-target-conflict",
				"rename target already exists",
				candidate.path,
			),
		};
	}

	if (
		candidate.sourceFormat === "search-replace" &&
		candidate.anchors[0]?.exactText
	) {
		const current = await file.text();
		const occurrences =
			current.split(candidate.anchors[0].exactText).length - 1;
		if (occurrences !== 1) {
			return {
				candidate,
				absolutePath,
				absolutePreviousPath,
				validation: failure(
					"ambiguous-anchor",
					occurrences === 0
						? "search anchor not found"
						: "search anchor is ambiguous",
					candidate.path,
				),
			};
		}

		const violation = detectBoundaryViolation(
			candidate.anchors[0].exactText,
			candidate.replacement ?? "",
		);
		if (violation) {
			return {
				candidate,
				absolutePath,
				absolutePreviousPath,
				validation: failure("structural-boundary", violation, candidate.path),
			};
		}
	}

	if (
		candidate.operation === "update" &&
		candidate.sourceFormat !== "patch-text" &&
		candidate.sourceFormat !== "unified-diff" &&
		candidate.anchors.length === 0
	) {
		return {
			candidate,
			absolutePath,
			absolutePreviousPath,
			validation: failure(
				"missing-read",
				"update candidate has no deterministic anchors",
				candidate.path,
			),
		};
	}

	return {
		candidate,
		absolutePath,
		absolutePreviousPath,
		validation: {
			ok: true,
			strategy:
				candidate.sourceFormat === "search-replace"
					? "hash-anchor"
					: "apply_patch",
			score: candidate.sourceFormat === "search-replace" ? 0.85 : 0.7,
			warnings: [],
		},
	};
}
