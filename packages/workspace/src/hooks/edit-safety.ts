/**
 * Edit Safety Guardrails
 *
 * Provides two protections for edit/write operations:
 * 1) Hashline-safe boundaries for structural edits
 * 2) Read-before-write precondition for existing files
 *
 * Enforcement strategy:
 * - If a violation is detected in tool.execute.before, we mutate filePath to a
 *   null-byte sentinel path so the underlying tool fails before any write.
 * - In tool.execute.after, we append violation telemetry as a system reminder.
 */

import { resolve } from "../bun-compat.js";
import { createLogger } from "../logging.js";

const logger = createLogger("workspace.edit-safety");

const DEFAULT_READ_TTL_MS = 10 * 60 * 1000;
const BLOCKED_FILE_PATH = "\u0000";

const STRUCTURAL_HASHLINE_PATTERNS = [/^#{1,6}\s+/, /^```/, /^---$/] as const;

const VIOLATION_REMINDER_HEADER = `
<system-reminder>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ EDIT SAFETY GUARD BLOCKED THE OPERATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

const VIOLATION_REMINDER_FOOTER = `

Required next steps:
1. Read the target file first to refresh state
2. Narrow edits to deterministic structural boundaries
3. Retry with precise oldString/newString anchors
</system-reminder>`;

type ReadState = Map<string, number>;

const sessionReads = new Map<string, ReadState>();
const blockedViolations = new Map<string, string[]>();

export interface EditSafetyBeforeInput {
	tool: string;
	sessionID: string;
	callID: string;
}

export interface EditSafetyBeforeOutput {
	args: Record<string, unknown>;
}

export interface EditSafetyAfterInput {
	tool: string;
	sessionID: string;
	callID: string;
	args?: unknown;
}

export interface EditSafetyAfterOutput {
	output?: string;
}

interface EditSafetyOptions {
	readTtlMs?: number;
}

function getFilePath(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const filePath = (args as Record<string, unknown>).filePath;
	if (typeof filePath !== "string") return null;
	if (filePath.trim().length === 0) return null;
	return filePath;
}

function getStringArg(args: unknown, key: string): string {
	if (!args || typeof args !== "object") return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function normalizePath(directory: string, filePath: string): string {
	return resolve(directory, filePath);
}

function getSessionReadState(sessionID: string): ReadState {
	const existing = sessionReads.get(sessionID);
	if (existing) return existing;
	const created: ReadState = new Map();
	sessionReads.set(sessionID, created);
	return created;
}

function recordRead(sessionID: string, filePath: string): void {
	const state = getSessionReadState(sessionID);
	state.set(filePath, Date.now());
}

function pruneReads(sessionID: string, now: number, readTtlMs: number): void {
	const state = sessionReads.get(sessionID);
	if (!state) return;

	for (const [filePath, readAt] of state.entries()) {
		if (now - readAt > readTtlMs) {
			state.delete(filePath);
		}
	}

	if (state.size === 0) {
		sessionReads.delete(sessionID);
	}
}

function readFreshnessViolation(
	sessionID: string,
	filePath: string,
	readTtlMs: number,
): string | null {
	const state = sessionReads.get(sessionID);
	if (!state) {
		return `Read-before-write precondition failed: ${filePath} has not been read in this session.`;
	}

	const readAt = state.get(filePath);
	if (!readAt) {
		return `Read-before-write precondition failed: ${filePath} has not been read in this session.`;
	}

	const ageMs = Date.now() - readAt;
	if (ageMs > readTtlMs) {
		return `Read-before-write precondition failed: ${filePath} was read ${Math.round(ageMs / 1000)}s ago and is stale.`;
	}

	return null;
}

function countPatternMatches(lines: string[], pattern: RegExp): number {
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line.trim())) count++;
	}
	return count;
}

export function detectHashlineBoundaryViolation(
	oldString: string,
	newString: string,
): string | null {
	if (!oldString) return null;

	const oldLines = oldString.split("\n");
	const newLines = newString.split("\n");

	const headingCount = countPatternMatches(oldLines, /^#{1,6}\s+/);
	if (headingCount > 1) {
		return "Hashline-safe boundary violation: edit spans multiple markdown heading anchors.";
	}

	const oldCodeFenceCount = countPatternMatches(oldLines, /^```/);
	const newCodeFenceCount = countPatternMatches(newLines, /^```/);
	if (oldCodeFenceCount % 2 !== 0 || newCodeFenceCount % 2 !== 0) {
		return "Hashline-safe boundary violation: unbalanced code-fence anchors detected.";
	}

	const oldYamlFenceCount = countPatternMatches(oldLines, /^---$/);
	const newYamlFenceCount = countPatternMatches(newLines, /^---$/);
	if (oldYamlFenceCount % 2 !== 0 || newYamlFenceCount % 2 !== 0) {
		return "Hashline-safe boundary violation: unbalanced frontmatter fence anchors detected.";
	}

	const hasStructuralLine = oldLines.some((line) =>
		STRUCTURAL_HASHLINE_PATTERNS.some((pattern) => pattern.test(line.trim())),
	);
	if (hasStructuralLine && oldLines.length > 1 && !oldString.endsWith("\n")) {
		return "Hashline-safe boundary violation: structural multi-line edit must end on a full line boundary.";
	}

	return null;
}

function blockOperation(
	callID: string,
	args: Record<string, unknown>,
	violations: string[],
): void {
	blockedViolations.set(callID, violations);
	args.filePath = BLOCKED_FILE_PATH;
}

function formatViolationReminder(violations: string[]): string {
	const details = violations.map((violation) => `- ${violation}`).join("\n");
	return `${VIOLATION_REMINDER_HEADER}\n\nViolations:\n${details}${VIOLATION_REMINDER_FOOTER}`;
}

export function createEditSafetyBeforeHook(
	directory: string,
	options?: EditSafetyOptions,
): (
	input: EditSafetyBeforeInput,
	output: EditSafetyBeforeOutput,
) => Promise<void> {
	const readTtlMs = options?.readTtlMs ?? DEFAULT_READ_TTL_MS;

	return async (input, output) => {
		const toolName = input.tool.toLowerCase();
		if (
			toolName !== "edit" &&
			toolName !== "write" &&
			toolName !== "hash_anchored_edit"
		)
			return;

		const args = output.args;
		const filePath = getFilePath(args);
		if (!filePath) return;

		const absolutePath = normalizePath(directory, filePath);
		const fileExists = await Bun.file(absolutePath).exists();
		const violations: string[] = [];

		if (toolName === "edit") {
			const oldString = getStringArg(args, "oldString");
			const newString = getStringArg(args, "newString");
			const hashlineViolation = detectHashlineBoundaryViolation(
				oldString,
				newString,
			);
			if (hashlineViolation) {
				violations.push(hashlineViolation);
			}
		}

		if (fileExists) {
			const freshnessViolation = readFreshnessViolation(
				input.sessionID,
				absolutePath,
				readTtlMs,
			);
			if (freshnessViolation) {
				violations.push(freshnessViolation);
			}
		}

		if (violations.length === 0) return;

		blockOperation(input.callID, args, violations);
		logger.warn("Blocked unsafe edit/write request", {
			tool: toolName,
			filePath: absolutePath,
			violations: violations.length,
		});
	};
}

function isLikelyFailureOutput(output: string | undefined): boolean {
	if (typeof output !== "string") return false;
	const trimmed = output.trim();
	if (!trimmed) return false;
	return /^❌/i.test(trimmed) || /^error[:\s]/i.test(trimmed);
}

export function createEditSafetyAfterHook(
	directory: string,
): (
	input: EditSafetyAfterInput,
	output: EditSafetyAfterOutput,
) => Promise<void> {
	return async (input, output) => {
		const toolName = input.tool.toLowerCase();

		if (toolName === "read") {
			const filePath = getFilePath(input.args);
			if (filePath) {
				const absolutePath = normalizePath(directory, filePath);
				const fileExists = await Bun.file(absolutePath).exists();
				if (fileExists && !isLikelyFailureOutput(output.output)) {
					recordRead(input.sessionID, absolutePath);
					pruneReads(input.sessionID, Date.now(), DEFAULT_READ_TTL_MS);
				}
			}
		}

		const violations = blockedViolations.get(input.callID);
		if (!violations) return;

		if (typeof output.output === "string") {
			output.output += formatViolationReminder(violations);
		}

		blockedViolations.delete(input.callID);
	};
}

export function resetEditSafetyState(): void {
	blockedViolations.clear();
	sessionReads.clear();
}

export { DEFAULT_READ_TTL_MS, BLOCKED_FILE_PATH };
