import { parseEditFormats } from "./parsers/index.js";
import type { RawParsedEdit } from "./shared.js";

export interface RecoveryResult {
	normalizedText: string;
	edits: RawParsedEdit[];
	recoverySteps: string[];
}

function stripWrapperText(text: string): { text: string; changed: boolean } {
	const patchStart = text.indexOf("*** Begin Patch");
	if (patchStart !== -1) {
		const patchEnd = text.indexOf("*** End Patch");
		return {
			text: text.slice(patchStart, patchEnd === -1 ? undefined : patchEnd + 13),
			changed: patchStart !== 0 || patchEnd !== text.length - 13,
		};
	}

	const fenceStart = text.indexOf("```");
	const fenceEnd = text.lastIndexOf("```");
	if (fenceStart !== -1 && fenceEnd > fenceStart) {
		return {
			text: text.slice(fenceStart, fenceEnd + 3),
			changed: fenceStart !== 0 || fenceEnd + 3 !== text.length,
		};
	}

	const jsonStart = text.search(/[[{]/);
	const jsonEnd = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
	if (jsonStart !== -1 && jsonEnd > jsonStart) {
		return {
			text: text.slice(jsonStart, jsonEnd + 1),
			changed: jsonStart !== 0 || jsonEnd + 1 !== text.length,
		};
	}

	return { text: text.trim(), changed: text.trim() !== text };
}

function cleanupTrailingCommas(text: string): {
	text: string;
	changed: boolean;
} {
	const next = text.replace(/,\s*([}\]])/g, "$1");
	return { text: next, changed: next !== text };
}

function repairFences(text: string): { text: string; changed: boolean } {
	const count = [...text.matchAll(/```/g)].length;
	if (count % 2 === 0) {
		return { text, changed: false };
	}
	return { text: `${text}\n\`\`\``, changed: true };
}

function salvageSearchReplace(text: string): {
	text: string;
	changed: boolean;
} {
	if (
		text.includes("<<<<<<< SEARCH") &&
		text.includes("=======") &&
		!text.includes(">>>>>>> REPLACE")
	) {
		return { text: `${text}\n>>>>>>> REPLACE`, changed: true };
	}
	return { text, changed: false };
}

function recoverMissingFilenames(
	edits: RawParsedEdit[],
	contextPaths: string[],
): RawParsedEdit[] {
	if (contextPaths.length !== 1) return edits;
	return edits.map((edit) =>
		edit.path ? edit : { ...edit, path: contextPaths[0] },
	);
}

export function recoverParsedEdits(
	text: string,
	contextPaths: string[] = [],
): RecoveryResult {
	let normalizedText = text;
	const recoverySteps: string[] = [];
	const transforms = [
		stripWrapperText,
		cleanupTrailingCommas,
		repairFences,
		salvageSearchReplace,
	];

	for (const transform of transforms) {
		const next = transform(normalizedText);
		if (next.changed) {
			normalizedText = next.text;
			recoverySteps.push(transform.name);
		}
	}

	const edits = recoverMissingFilenames(
		parseEditFormats(normalizedText),
		contextPaths,
	);
	return {
		normalizedText,
		edits,
		recoverySteps,
	};
}
