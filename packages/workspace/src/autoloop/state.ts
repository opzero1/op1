import type {
	ContinuationMode,
	ContinuationSessionRecord,
} from "../continuation/state.js";

export type AutoloopIterationOutcome = "keep" | "discard" | "blocked" | "done";

export type AutoloopEffectiveMode = ContinuationMode | "paused";

export interface AutoloopConfigEntry {
	type: "config";
	timestamp: string;
	goal: string;
	iteration?: number;
	slug?: string;
	scope?: string[];
	stop_conditions?: string[];
	max_iterations?: number;
	next_step?: string;
}

export interface AutoloopIterationEntry {
	type: "iteration";
	iteration: number;
	timestamp: string;
	action: string;
	files_changed: string[];
	verification: string[];
	status: string;
	outcome: AutoloopIterationOutcome;
	next_step: string;
}

export type AutoloopStateEntry = AutoloopConfigEntry | AutoloopIterationEntry;

export interface AutoloopStateParseIssue {
	line: number;
	reason: string;
	raw: string;
}

export interface ParsedAutoloopStateFile {
	entries: AutoloopStateEntry[];
	issues: AutoloopStateParseIssue[];
}

export interface AutoloopStatusSnapshot {
	lifecycle_source: "dedicated-plan";
	slug?: string;
	paused: boolean;
	continuation_mode: ContinuationMode;
	effective_mode: AutoloopEffectiveMode;
	continuation_updated_at?: string;
	continuation_reason?: string;
	latest_iteration?: number;
	max_iterations?: number;
	next_step?: string;
}

export interface CreateAutoloopIterationInput {
	timestamp?: string;
	action: string;
	files_changed?: string[];
	verification?: string[];
	status: string;
	outcome: AutoloopIterationOutcome;
	next_step: string;
}

const VALID_OUTCOMES: ReadonlySet<AutoloopIterationOutcome> = new Set([
	"keep",
	"discard",
	"blocked",
	"done",
]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isNonEmptyString);
}

function normalizeIterationNumber(value: unknown): number | undefined {
	if (!Number.isInteger(value) || (value as number) < 0) {
		return undefined;
	}
	return value as number;
}

function normalizeConfigEntry(
	value: Record<string, unknown>,
): AutoloopConfigEntry | null {
	if (!isNonEmptyString(value.timestamp) || !isNonEmptyString(value.goal)) {
		return null;
	}

	return {
		type: "config",
		timestamp: value.timestamp,
		goal: value.goal,
		iteration: normalizeIterationNumber(value.iteration),
		slug: isNonEmptyString(value.slug) ? value.slug : undefined,
		scope: normalizeStringArray(value.scope),
		stop_conditions: normalizeStringArray(value.stop_conditions),
		max_iterations:
			Number.isInteger(value.max_iterations) &&
			(value.max_iterations as number) > 0
				? (value.max_iterations as number)
				: undefined,
		next_step: isNonEmptyString(value.next_step) ? value.next_step : undefined,
	};
}

function normalizeIterationEntry(
	value: Record<string, unknown>,
): AutoloopIterationEntry | null {
	if (
		normalizeIterationNumber(value.iteration) === undefined ||
		!isNonEmptyString(value.timestamp) ||
		!isNonEmptyString(value.action) ||
		!isNonEmptyString(value.status) ||
		!isNonEmptyString(value.next_step) ||
		!VALID_OUTCOMES.has(value.outcome as AutoloopIterationOutcome)
	) {
		return null;
	}

	return {
		type: "iteration",
		iteration: value.iteration as number,
		timestamp: value.timestamp,
		action: value.action,
		files_changed: normalizeStringArray(value.files_changed),
		verification: normalizeStringArray(value.verification),
		status: value.status,
		outcome: value.outcome as AutoloopIterationOutcome,
		next_step: value.next_step,
	};
}

export function normalizeAutoloopStateEntry(
	value: unknown,
): AutoloopStateEntry | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.type === "config") {
		return normalizeConfigEntry(raw);
	}
	if (raw.type === "iteration") {
		return normalizeIterationEntry(raw);
	}
	return null;
}

export function parseAutoloopStateLine(
	line: string,
): AutoloopStateEntry | null {
	const trimmed = line.replace(/^\uFEFF/, "").trim();
	if (!trimmed) return null;

	try {
		return normalizeAutoloopStateEntry(JSON.parse(trimmed));
	} catch {
		return null;
	}
}

export function parseAutoloopStateFile(
	content: string,
): ParsedAutoloopStateFile {
	const entries: AutoloopStateEntry[] = [];
	const issues: AutoloopStateParseIssue[] = [];

	for (const [index, rawLine] of content
		.replace(/\r\n/g, "\n")
		.split("\n")
		.entries()) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;

		try {
			const parsed = normalizeAutoloopStateEntry(JSON.parse(trimmed));
			if (!parsed) {
				issues.push({
					line: index + 1,
					reason: "schema mismatch",
					raw: rawLine,
				});
				continue;
			}

			entries.push(parsed);
		} catch {
			issues.push({
				line: index + 1,
				reason: "invalid json",
				raw: rawLine,
			});
		}
	}

	return { entries, issues };
}

export function serializeAutoloopStateEntry(entry: AutoloopStateEntry): string {
	return JSON.stringify(entry);
}

export function getLatestAutoloopConfig(
	entries: readonly AutoloopStateEntry[],
): AutoloopConfigEntry | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "config") {
			return entry;
		}
	}

	return null;
}

export function getLatestAutoloopIteration(
	entries: readonly AutoloopStateEntry[],
): AutoloopIterationEntry | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "iteration") {
			return entry;
		}
	}

	return null;
}

export function getNextAutoloopIterationNumber(
	entries: readonly AutoloopStateEntry[],
): number {
	let maxIteration = 0;

	for (const entry of entries) {
		if (entry.type === "iteration" && entry.iteration > maxIteration) {
			maxIteration = entry.iteration;
		}
	}

	return maxIteration + 1;
}

export function createAutoloopIterationEntry(
	entries: readonly AutoloopStateEntry[],
	input: CreateAutoloopIterationInput,
): AutoloopIterationEntry {
	return {
		type: "iteration",
		iteration: getNextAutoloopIterationNumber(entries),
		timestamp: input.timestamp?.trim() || new Date().toISOString(),
		action: input.action,
		files_changed: normalizeStringArray(input.files_changed),
		verification: normalizeStringArray(input.verification),
		status: input.status,
		outcome: input.outcome,
		next_step: input.next_step,
	};
}

export function buildAutoloopStatusSnapshot(
	entries: readonly AutoloopStateEntry[],
	input?: {
		paused?: boolean;
		continuation?: Pick<
			ContinuationSessionRecord,
			"mode" | "updated_at" | "reason"
		> | null;
	},
): AutoloopStatusSnapshot {
	const latestConfig = getLatestAutoloopConfig(entries);
	const latestIteration = getLatestAutoloopIteration(entries);
	const paused = input?.paused === true;
	const continuationMode = input?.continuation?.mode ?? "running";

	return {
		lifecycle_source: "dedicated-plan",
		slug: latestConfig?.slug,
		paused,
		continuation_mode: continuationMode,
		effective_mode: paused ? "paused" : continuationMode,
		continuation_updated_at: input?.continuation?.updated_at,
		continuation_reason: input?.continuation?.reason,
		latest_iteration: latestIteration?.iteration,
		max_iterations: latestConfig?.max_iterations,
		next_step: latestIteration?.next_step ?? latestConfig?.next_step,
	};
}
