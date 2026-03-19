/**
 * Plan State Management
 *
 * Active plan state, notepad helpers, slug generation, metadata generation,
 * and plan-linked documentation registry.
 *
 * All operations are project-scoped (stored in .opencode/workspace/).
 */

import { basename, join, mkdir, readdir, rm } from "../bun-compat.js";
import {
	type JsonRecoveryMethod,
	recordJsonRecoveryFailure,
	recordJsonRecoveryMatch,
} from "../json-recovery-observability.js";
import { createLogger } from "../logging.js";
import { isSystemError } from "../utils.js";

const logger = createLogger("workspace.plan-state");

// ==========================================
// TYPES
// ==========================================

export interface ActivePlanState {
	active_plan: string;
	started_at: string;
	session_ids: string[];
	plan_name: string;
	title?: string;
	description?: string;
}

export interface PlanMetadata {
	title: string;
	description: string;
}

export type PlanDocType = "prd" | "rfc" | "ticket" | "notes" | "other";

export interface PlanDocLink {
	id: string;
	path: string;
	type: PlanDocType;
	title?: string;
	phase?: string;
	task?: string;
	notes?: string;
	linked_at: string;
}

export interface PlanDocBacklink {
	plan_name: string;
	phase?: string;
	task?: string;
	linked_at: string;
}

export interface PlanDocIndexEntry {
	id: string;
	path: string;
	type: PlanDocType;
	title?: string;
	linked_plans: PlanDocBacklink[];
}

export interface PlanDocRegistry {
	version: 1;
	plans: Record<string, PlanDocLink[]>;
	docs: Record<string, PlanDocIndexEntry>;
}

export interface LinkPlanDocInput {
	path: string;
	type: PlanDocType;
	title?: string;
	phase?: string;
	task?: string;
	notes?: string;
}

export type PlanLifecycle = "active" | "inactive" | "archived" | "draft";

export interface PlanRegistryEntry {
	plan_name: string;
	path: string;
	lifecycle: PlanLifecycle;
	created_at: string;
	updated_at: string;
	archived_at?: string;
	title?: string;
	description?: string;
}

export interface PlanRegistry {
	version: 1;
	plans: Record<string, PlanRegistryEntry>;
}

export type PlanContextStage = "draft" | "confirmed" | "active" | "archived";

export interface PlanQuestionAnswer {
	id: string;
	question: string;
	header?: string;
	answers: string[];
	source: "question-tool" | "freeform";
	phase?: string;
	task?: string;
	confirmed_by_user: boolean;
	captured_at: string;
}

export interface ConfirmedPatternExample {
	name: string;
	source_type: "repo" | "best-practice";
	example_files: string[];
	symbols: string[];
	why_it_fits: string;
	constraints: string[];
	blast_radius: string[];
	test_implications: string[];
	code_example?: string;
	confirmed_by_user: boolean;
}

export interface PlanContextRecord {
	version: 1;
	plan_name: string;
	stage: PlanContextStage;
	confirmed_by_user: boolean;
	goal?: string;
	chosen_pattern?: string;
	affected_areas: string[];
	blast_radius: string[];
	success_criteria: string[];
	failure_criteria: string[];
	test_plan: string[];
	open_risks: string[];
	oracle_summary?: string;
	question_answers: PlanQuestionAnswer[];
	pattern_examples: ConfirmedPatternExample[];
	updated_at: string;
}

export interface PlanContextPatch {
	stage?: PlanContextStage;
	confirmed_by_user?: boolean;
	goal?: string;
	chosen_pattern?: string;
	affected_areas?: string[];
	blast_radius?: string[];
	success_criteria?: string[];
	failure_criteria?: string[];
	test_plan?: string[];
	open_risks?: string[];
	oracle_summary?: string;
	question_answers?: PlanQuestionAnswer[];
	pattern_examples?: ConfirmedPatternExample[];
}

// ==========================================
// NOTEPAD
// ==========================================

export const NOTEPAD_FILES = [
	"learnings.md",
	"issues.md",
	"decisions.md",
] as const;
export type NotepadFile = (typeof NOTEPAD_FILES)[number];

// ==========================================
// SLUG GENERATION
// ==========================================

const ADJECTIVES = [
	"brave",
	"calm",
	"clever",
	"cosmic",
	"crisp",
	"curious",
	"eager",
	"gentle",
	"glowing",
	"happy",
	"hidden",
	"jolly",
	"kind",
	"lucky",
	"mighty",
	"misty",
	"neon",
	"nimble",
	"playful",
	"proud",
	"quick",
	"quiet",
	"shiny",
	"silent",
	"stellar",
	"sunny",
	"swift",
	"tidy",
	"witty",
] as const;

const NOUNS = [
	"cabin",
	"cactus",
	"canyon",
	"circuit",
	"comet",
	"eagle",
	"engine",
	"falcon",
	"forest",
	"garden",
	"harbor",
	"island",
	"knight",
	"lagoon",
	"meadow",
	"moon",
	"mountain",
	"nebula",
	"orchid",
	"otter",
	"panda",
	"pixel",
	"planet",
	"river",
	"rocket",
	"sailor",
	"squid",
	"star",
	"tiger",
	"wizard",
	"wolf",
] as const;

function generateSlug(): string {
	return [
		ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
		NOUNS[Math.floor(Math.random() * NOUNS.length)],
	].join("-");
}

function nowIso(): string {
	return new Date().toISOString();
}

async function acquireDirectoryLock(
	lockPath: string,
	timeoutMs: number = 5000,
): Promise<() => Promise<void>> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		try {
			await mkdir(lockPath);
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (error) {
			if (
				error instanceof Error &&
				/(File exists|EEXIST)/.test(error.message)
			) {
				await new Promise((resolve) => setTimeout(resolve, 25));
				continue;
			}
			throw error;
		}
	}

	throw new Error(
		`Plan doc registry lock timeout after ${timeoutMs}ms: ${lockPath}`,
	);
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function uniqueStrings(values: string[]): string[] {
	return [
		...new Set(
			values.filter((v) => typeof v === "string" && v.trim().length > 0),
		),
	];
}

function uniqueStringsOrEmpty(values?: string[]): string[] {
	return uniqueStrings(values ?? []);
}

function derivePlanMetadataFallback(
	planName: string,
	content: string,
): PlanMetadata {
	const goalMatch = content.match(/## Goal\n\n?([^\n#]+)/);
	const goal = goalMatch?.[1]?.trim();

	if (goal) {
		return {
			title: goal.length > 40 ? `${goal.slice(0, 37)}...` : goal,
			description: goal.length > 150 ? `${goal.slice(0, 147)}...` : goal,
		};
	}

	const firstHeadingMatch = content.match(/^#\s+(.+)$/m);
	const title = firstHeadingMatch?.[1]?.trim() || planName;

	return {
		title: title.length > 40 ? `${title.slice(0, 37)}...` : title,
		description: `Implementation plan (${todayIso()})`,
	};
}

function generateDocID(): string {
	return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateQuestionAnswerID(): string {
	return `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeQuestionAnswer(value: unknown): PlanQuestionAnswer | null {
	if (!value || typeof value !== "object") return null;

	const raw = value as Record<string, unknown>;
	if (typeof raw.question !== "string" || raw.question.trim().length === 0) {
		return null;
	}

	return {
		id:
			typeof raw.id === "string" && raw.id.trim().length > 0
				? raw.id
				: generateQuestionAnswerID(),
		question: raw.question.trim(),
		header:
			typeof raw.header === "string" && raw.header.trim().length > 0
				? raw.header.trim()
				: undefined,
		answers: uniqueStrings(
			Array.isArray(raw.answers) ? (raw.answers as string[]) : [],
		),
		source: raw.source === "question-tool" ? "question-tool" : "freeform",
		phase:
			typeof raw.phase === "string" && raw.phase.trim().length > 0
				? raw.phase.trim()
				: undefined,
		task:
			typeof raw.task === "string" && raw.task.trim().length > 0
				? raw.task.trim()
				: undefined,
		confirmed_by_user: raw.confirmed_by_user !== false,
		captured_at:
			typeof raw.captured_at === "string" && raw.captured_at.trim().length > 0
				? raw.captured_at
				: nowIso(),
	};
}

function normalizePatternExample(
	value: unknown,
): ConfirmedPatternExample | null {
	if (!value || typeof value !== "object") return null;

	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
		return null;
	}
	if (
		typeof raw.why_it_fits !== "string" ||
		raw.why_it_fits.trim().length === 0
	) {
		return null;
	}

	return {
		name: raw.name.trim(),
		source_type: raw.source_type === "best-practice" ? "best-practice" : "repo",
		example_files: uniqueStrings(
			Array.isArray(raw.example_files) ? (raw.example_files as string[]) : [],
		),
		symbols: uniqueStrings(
			Array.isArray(raw.symbols) ? (raw.symbols as string[]) : [],
		),
		why_it_fits: raw.why_it_fits.trim(),
		constraints: uniqueStrings(
			Array.isArray(raw.constraints) ? (raw.constraints as string[]) : [],
		),
		blast_radius: uniqueStrings(
			Array.isArray(raw.blast_radius) ? (raw.blast_radius as string[]) : [],
		),
		test_implications: uniqueStrings(
			Array.isArray(raw.test_implications)
				? (raw.test_implications as string[])
				: [],
		),
		code_example:
			typeof raw.code_example === "string" && raw.code_example.trim().length > 0
				? raw.code_example.trim()
				: undefined,
		confirmed_by_user: raw.confirmed_by_user !== false,
	};
}

function createEmptyPlanContext(planName: string): PlanContextRecord {
	return {
		version: 1,
		plan_name: planName,
		stage: "draft",
		confirmed_by_user: false,
		affected_areas: [],
		blast_radius: [],
		success_criteria: [],
		failure_criteria: [],
		test_plan: [],
		open_risks: [],
		question_answers: [],
		pattern_examples: [],
		updated_at: nowIso(),
	};
}

function normalizePlanContextRecord(
	data: unknown,
	planName: string,
): PlanContextRecord {
	if (!data || typeof data !== "object") {
		return createEmptyPlanContext(planName);
	}

	const raw = data as Record<string, unknown>;
	const questionAnswers = Array.isArray(raw.question_answers)
		? raw.question_answers
				.map((item) => normalizeQuestionAnswer(item))
				.filter((item): item is PlanQuestionAnswer => item !== null)
		: [];
	const patternExamples = Array.isArray(raw.pattern_examples)
		? raw.pattern_examples
				.map((item) => normalizePatternExample(item))
				.filter((item): item is ConfirmedPatternExample => item !== null)
		: [];

	return {
		version: 1,
		plan_name:
			typeof raw.plan_name === "string" && raw.plan_name.trim().length > 0
				? raw.plan_name
				: planName,
		stage:
			raw.stage === "confirmed" ||
			raw.stage === "active" ||
			raw.stage === "archived"
				? raw.stage
				: "draft",
		confirmed_by_user: raw.confirmed_by_user === true,
		goal:
			typeof raw.goal === "string" && raw.goal.trim().length > 0
				? raw.goal.trim()
				: undefined,
		chosen_pattern:
			typeof raw.chosen_pattern === "string" &&
			raw.chosen_pattern.trim().length > 0
				? raw.chosen_pattern.trim()
				: undefined,
		affected_areas: uniqueStrings(
			Array.isArray(raw.affected_areas) ? (raw.affected_areas as string[]) : [],
		),
		blast_radius: uniqueStrings(
			Array.isArray(raw.blast_radius) ? (raw.blast_radius as string[]) : [],
		),
		success_criteria: uniqueStrings(
			Array.isArray(raw.success_criteria)
				? (raw.success_criteria as string[])
				: [],
		),
		failure_criteria: uniqueStrings(
			Array.isArray(raw.failure_criteria)
				? (raw.failure_criteria as string[])
				: [],
		),
		test_plan: uniqueStrings(
			Array.isArray(raw.test_plan) ? (raw.test_plan as string[]) : [],
		),
		open_risks: uniqueStrings(
			Array.isArray(raw.open_risks) ? (raw.open_risks as string[]) : [],
		),
		oracle_summary:
			typeof raw.oracle_summary === "string" &&
			raw.oracle_summary.trim().length > 0
				? raw.oracle_summary.trim()
				: undefined,
		question_answers: questionAnswers,
		pattern_examples: patternExamples,
		updated_at:
			typeof raw.updated_at === "string" && raw.updated_at.trim().length > 0
				? raw.updated_at
				: nowIso(),
	};
}

async function readTextIfExists(path: string): Promise<string | null> {
	try {
		const file = Bun.file(path);
		return await file.text();
	} catch (error) {
		if (isSystemError(error) && error.code === "ENOENT") return null;
		throw error;
	}
}

function parseJsonWithRecovery(
	content: string,
	sourcePath: string,
): unknown | null {
	function logRecoveryMatch(method: JsonRecoveryMethod, message: string): void {
		const recorded = recordJsonRecoveryMatch(sourcePath, method);
		if (recorded.suppressed) {
			logger.debug("Suppressed duplicate JSON recovery marker", {
				source: sourcePath,
				recovery_method: method,
				observability_event: "workspace_json_recovery_dedup_skip_total",
			});
			return;
		}

		logger.warn(message, {
			source: sourcePath,
			recovery_method: method,
			observability_event: "workspace_json_recovery_match_total",
		});
	}

	const normalized = content.replace(/^\uFEFF/, "").trim();
	if (!normalized) return null;

	try {
		return JSON.parse(normalized);
	} catch {
		// Compatibility check 1: tolerate trailing commas in object/array literals
		const withoutTrailingCommas = normalized.replace(/,\s*([}\]])/g, "$1");
		if (withoutTrailingCommas !== normalized) {
			try {
				const parsed = JSON.parse(withoutTrailingCommas);
				logRecoveryMatch(
					"trailing_comma_cleanup",
					"Recovered malformed JSON with trailing comma cleanup",
				);
				return parsed;
			} catch {
				// continue recovery attempts
			}
		}

		// Compatibility check 2: recover first complete JSON object region
		const objectStart = withoutTrailingCommas.indexOf("{");
		const objectEnd = withoutTrailingCommas.lastIndexOf("}");
		if (objectStart >= 0 && objectEnd > objectStart) {
			const objectSlice = withoutTrailingCommas.slice(
				objectStart,
				objectEnd + 1,
			);
			try {
				const parsed = JSON.parse(objectSlice);
				logRecoveryMatch(
					"object_boundary_extraction",
					"Recovered malformed JSON by object boundary extraction",
				);
				return parsed;
			} catch {
				// continue recovery attempts
			}
		}

		// Compatibility check 3: recover first complete JSON array region
		const arrayStart = withoutTrailingCommas.indexOf("[");
		const arrayEnd = withoutTrailingCommas.lastIndexOf("]");
		if (arrayStart >= 0 && arrayEnd > arrayStart) {
			const arraySlice = withoutTrailingCommas.slice(arrayStart, arrayEnd + 1);
			try {
				const parsed = JSON.parse(arraySlice);
				logRecoveryMatch(
					"array_boundary_extraction",
					"Recovered malformed JSON by array boundary extraction",
				);
				return parsed;
			} catch {
				// recovery exhausted
			}
		}

		recordJsonRecoveryFailure();
		logger.error("JSON parse recovery failed", {
			source: sourcePath,
			observability_event: "workspace_json_recovery_fail_total",
		});
		return null;
	}
}

function normalizeActivePlanState(data: unknown): ActivePlanState | null {
	if (!data || typeof data !== "object") return null;

	const raw = data as Record<string, unknown>;
	if (typeof raw.active_plan !== "string") return null;

	const planName =
		typeof raw.plan_name === "string" && raw.plan_name.trim().length > 0
			? raw.plan_name
			: getPlanName(raw.active_plan);

	return {
		active_plan: raw.active_plan,
		started_at: typeof raw.started_at === "string" ? raw.started_at : nowIso(),
		session_ids: uniqueStrings(
			Array.isArray(raw.session_ids) ? (raw.session_ids as string[]) : [],
		),
		plan_name: planName,
		title: typeof raw.title === "string" ? raw.title : undefined,
		description:
			typeof raw.description === "string" ? raw.description : undefined,
	};
}

function createEmptyPlanDocRegistry(): PlanDocRegistry {
	return {
		version: 1,
		plans: {},
		docs: {},
	};
}

function createEmptyPlanRegistry(): PlanRegistry {
	return {
		version: 1,
		plans: {},
	};
}

function normalizePlanRegistry(data: unknown): PlanRegistry {
	if (!data || typeof data !== "object") {
		return createEmptyPlanRegistry();
	}

	const raw = data as Record<string, unknown>;
	const plansRaw = raw.plans;
	if (!plansRaw || typeof plansRaw !== "object") {
		return createEmptyPlanRegistry();
	}

	const plans: Record<string, PlanRegistryEntry> = {};
	for (const [planName, entry] of Object.entries(
		plansRaw as Record<string, unknown>,
	)) {
		if (!entry || typeof entry !== "object") continue;

		const record = entry as Record<string, unknown>;
		if (typeof record.path !== "string") continue;

		const lifecycle =
			record.lifecycle === "active" ||
			record.lifecycle === "inactive" ||
			record.lifecycle === "archived" ||
			record.lifecycle === "draft"
				? record.lifecycle
				: "inactive";

		plans[planName] = {
			plan_name: planName,
			path: record.path,
			lifecycle,
			created_at:
				typeof record.created_at === "string" ? record.created_at : nowIso(),
			updated_at:
				typeof record.updated_at === "string" ? record.updated_at : nowIso(),
			archived_at:
				typeof record.archived_at === "string" ? record.archived_at : undefined,
			title: typeof record.title === "string" ? record.title : undefined,
			description:
				typeof record.description === "string" ? record.description : undefined,
		};
	}

	return {
		version: 1,
		plans,
	};
}

function normalizePlanDocRegistry(data: unknown): PlanDocRegistry {
	if (!data || typeof data !== "object") {
		return createEmptyPlanDocRegistry();
	}

	const raw = data as Record<string, unknown>;
	const plansRaw = raw.plans;
	const docsRaw = raw.docs;

	const plans: Record<string, PlanDocLink[]> = {};
	if (plansRaw && typeof plansRaw === "object") {
		for (const [planName, links] of Object.entries(
			plansRaw as Record<string, unknown>,
		)) {
			if (!Array.isArray(links)) continue;

			plans[planName] = links
				.filter(
					(link): link is Record<string, unknown> =>
						!!link && typeof link === "object",
				)
				.filter(
					(link) =>
						typeof link.id === "string" && typeof link.path === "string",
				)
				.map((link) => ({
					id: link.id as string,
					path: link.path as string,
					type: (typeof link.type === "string"
						? link.type
						: "other") as PlanDocType,
					title: typeof link.title === "string" ? link.title : undefined,
					phase: typeof link.phase === "string" ? link.phase : undefined,
					task: typeof link.task === "string" ? link.task : undefined,
					notes: typeof link.notes === "string" ? link.notes : undefined,
					linked_at:
						typeof link.linked_at === "string" ? link.linked_at : nowIso(),
				}));
		}
	}

	const docs: Record<string, PlanDocIndexEntry> = {};
	if (docsRaw && typeof docsRaw === "object") {
		for (const [id, entry] of Object.entries(
			docsRaw as Record<string, unknown>,
		)) {
			if (!entry || typeof entry !== "object") continue;

			const doc = entry as Record<string, unknown>;
			if (typeof doc.path !== "string") continue;

			const backlinksRaw = Array.isArray(doc.linked_plans)
				? doc.linked_plans
				: [];

			docs[id] = {
				id,
				path: doc.path,
				type: (typeof doc.type === "string"
					? doc.type
					: "other") as PlanDocType,
				title: typeof doc.title === "string" ? doc.title : undefined,
				linked_plans: backlinksRaw
					.filter(
						(p): p is Record<string, unknown> => !!p && typeof p === "object",
					)
					.filter((p) => typeof p.plan_name === "string")
					.map((p) => ({
						plan_name: p.plan_name as string,
						phase: typeof p.phase === "string" ? p.phase : undefined,
						task: typeof p.task === "string" ? p.task : undefined,
						linked_at: typeof p.linked_at === "string" ? p.linked_at : nowIso(),
					})),
			};
		}
	}

	return {
		version: 1,
		plans,
		docs,
	};
}

export function generatePlanPath(plansDir: string): string {
	const timestamp = Date.now();
	const slug = generateSlug();
	const filename = `${timestamp}-${slug}.md`;
	return join(plansDir, filename);
}

export function getPlanName(planPath: string): string {
	return basename(planPath, ".md");
}

// ==========================================
// STATE OPERATIONS
// ==========================================

export function createStateManager(
	workspaceDir: string,
	plansDir: string,
	notepadsDir: string,
	activePlanPath: string,
	importPlansDirs: string[] = [],
) {
	const planDocRegistryPath = join(workspaceDir, "plan-doc-links.json");
	const planDocRegistryLockPath = join(workspaceDir, ".plan-doc-links.lock");
	const planRegistryPath = join(workspaceDir, "plan-registry.json");
	const planRegistryLockPath = join(workspaceDir, ".plan-registry.lock");
	const planContextDir = join(workspaceDir, "plan-contexts");
	const planContextLockDir = join(workspaceDir, ".plan-context-locks");
	const activePlanLifecycleLockPath = join(
		workspaceDir,
		".active-plan-lifecycle.lock",
	);
	let activePlanLifecycleMutationQueue: Promise<void> = Promise.resolve();
	let planRegistryMutationQueue: Promise<void> = Promise.resolve();
	let planDocRegistryMutationQueue: Promise<void> = Promise.resolve();
	const planContextMutationQueues = new Map<string, Promise<void>>();
	const importRoots = importPlansDirs.filter(
		(dir, index, all) => dir.length > 0 && all.indexOf(dir) === index,
	);

	async function withPlanDocRegistryMutation<T>(
		work: () => Promise<T>,
	): Promise<T> {
		const previous = planDocRegistryMutationQueue.catch(() => undefined);
		let finishCurrent!: () => void;
		planDocRegistryMutationQueue = new Promise<void>((resolve) => {
			finishCurrent = resolve;
		});

		await previous;

		let release: (() => Promise<void>) | undefined;
		try {
			release = await acquireDirectoryLock(planDocRegistryLockPath);
			return await work();
		} finally {
			if (release) {
				await release();
			}
			finishCurrent();
		}
	}

	async function withPlanRegistryMutation<T>(
		work: () => Promise<T>,
	): Promise<T> {
		const previous = planRegistryMutationQueue.catch(() => undefined);
		let finishCurrent!: () => void;
		planRegistryMutationQueue = new Promise<void>((resolve) => {
			finishCurrent = resolve;
		});

		await previous;

		let release: (() => Promise<void>) | undefined;
		try {
			release = await acquireDirectoryLock(planRegistryLockPath);
			return await work();
		} finally {
			if (release) {
				await release();
			}
			finishCurrent();
		}
	}

	async function withPlanContextMutation<T>(
		planName: string,
		work: () => Promise<T>,
	): Promise<T> {
		const previous = planContextMutationQueues
			.get(planName)
			?.catch(() => undefined);
		let finishCurrent!: () => void;
		const current = new Promise<void>((resolve) => {
			finishCurrent = resolve;
		});
		planContextMutationQueues.set(planName, current);

		await previous;

		let release: (() => Promise<void>) | undefined;
		try {
			await mkdir(planContextLockDir, { recursive: true });
			const lockPath = join(
				planContextLockDir,
				`${planName.replace(/[^A-Za-z0-9._-]+/g, "-")}.lock`,
			);
			release = await acquireDirectoryLock(lockPath);
			return await work();
		} finally {
			if (release) {
				await release();
			}
			finishCurrent();
			if (planContextMutationQueues.get(planName) === current) {
				planContextMutationQueues.delete(planName);
			}
		}
	}

	async function withActivePlanLifecycleMutation<T>(
		work: () => Promise<T>,
	): Promise<T> {
		const previous = activePlanLifecycleMutationQueue.catch(() => undefined);
		let finishCurrent!: () => void;
		activePlanLifecycleMutationQueue = new Promise<void>((resolve) => {
			finishCurrent = resolve;
		});

		await previous;

		let release: (() => Promise<void>) | undefined;
		try {
			release = await acquireDirectoryLock(activePlanLifecycleLockPath);
			return await withPlanRegistryMutation(work);
		} finally {
			if (release) {
				await release();
			}
			finishCurrent();
		}
	}

	function getPlanContextPath(planName: string): string {
		return join(planContextDir, `${planName}.json`);
	}

	async function listPlansInDir(
		dir: string,
		options?: { ensure?: boolean },
	): Promise<string[]> {
		try {
			if (options?.ensure) {
				await mkdir(dir, { recursive: true });
			}
			const files = await readdir(dir);
			return files
				.filter((f) => f.endsWith(".md"))
				.map((f) => join(dir, f))
				.sort()
				.reverse();
		} catch (error) {
			if (!isSystemError(error) || error.code !== "ENOENT") throw error;
			return [];
		}
	}

	async function importExternalPlans(): Promise<void> {
		if (importRoots.length === 0) return;
		await mkdir(plansDir, { recursive: true });
		const existing = new Set(
			(await listPlansInDir(plansDir)).map((planPath) => getPlanName(planPath)),
		);

		for (const dir of importRoots) {
			const candidates = await listPlansInDir(dir);
			for (const planPath of candidates) {
				const planName = getPlanName(planPath);
				if (existing.has(planName)) continue;
				const content = await readTextIfExists(planPath);
				if (content === null) continue;
				await Bun.write(join(plansDir, `${planName}.md`), content);
				existing.add(planName);
			}
		}
	}

	async function listPlans(): Promise<string[]> {
		await listPlansInDir(plansDir, { ensure: true });
		await importExternalPlans();
		return await listPlansInDir(plansDir, { ensure: true });
	}

	async function readPlanRegistry(): Promise<PlanRegistry> {
		try {
			const content = await readTextIfExists(planRegistryPath);
			if (!content) return createEmptyPlanRegistry();
			const parsed = parseJsonWithRecovery(content, planRegistryPath);
			if (!parsed) return createEmptyPlanRegistry();
			return normalizePlanRegistry(parsed);
		} catch {
			return createEmptyPlanRegistry();
		}
	}

	async function writePlanRegistry(registry: PlanRegistry): Promise<void> {
		await mkdir(workspaceDir, { recursive: true });
		await Bun.write(planRegistryPath, JSON.stringify(registry, null, 2));
	}

	async function syncPlanRegistry(): Promise<PlanRegistry> {
		const registry = await readPlanRegistry();
		const planPaths = await listPlans();
		const planNames = new Set(planPaths.map((path) => getPlanName(path)));

		// Drop missing files
		for (const name of Object.keys(registry.plans)) {
			if (!planNames.has(name)) {
				delete registry.plans[name];
			}
		}

		for (const planPath of planPaths) {
			const planName = getPlanName(planPath);
			const existing = registry.plans[planName];

			if (existing) {
				existing.path = planPath;
				existing.updated_at = existing.updated_at || nowIso();
				continue;
			}

			const content = await readTextIfExists(planPath);
			const metadata = content
				? derivePlanMetadataFallback(planName, content)
				: {
						title: planName,
						description: `Implementation plan (${todayIso()})`,
					};

			registry.plans[planName] = {
				plan_name: planName,
				path: planPath,
				lifecycle: "inactive",
				created_at: nowIso(),
				updated_at: nowIso(),
				title: metadata.title,
				description: metadata.description,
			};
		}

		await writePlanRegistry(registry);
		return registry;
	}

	async function upsertPlanRegistryEntry(
		planPath: string,
		patch?: Partial<
			Pick<
				PlanRegistryEntry,
				"title" | "description" | "lifecycle" | "archived_at"
			>
		>,
	): Promise<PlanRegistryEntry> {
		return withPlanRegistryMutation(async () => {
			const registry = await syncPlanRegistry();
			const planName = getPlanName(planPath);

			const existing = registry.plans[planName];
			if (!existing) {
				const content = await readTextIfExists(planPath);
				const metadata = content
					? derivePlanMetadataFallback(planName, content)
					: {
							title: planName,
							description: `Implementation plan (${todayIso()})`,
						};

				registry.plans[planName] = {
					plan_name: planName,
					path: planPath,
					lifecycle: patch?.lifecycle || "inactive",
					created_at: nowIso(),
					updated_at: nowIso(),
					title: patch?.title || metadata.title,
					description: patch?.description || metadata.description,
					archived_at: patch?.archived_at,
				};
			} else {
				existing.path = planPath;
				existing.updated_at = nowIso();
				if (patch?.title) existing.title = patch.title;
				if (patch?.description) existing.description = patch.description;
				if (patch?.lifecycle) existing.lifecycle = patch.lifecycle;
				if (patch?.archived_at !== undefined)
					existing.archived_at = patch.archived_at;
			}

			await writePlanRegistry(registry);
			return registry.plans[planName];
		});
	}

	async function clearActivePlanStateFile(): Promise<void> {
		try {
			await rm(activePlanPath, { force: true });
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") return;
			throw error;
		}
	}

	async function clearActivePlanState(): Promise<void> {
		await withActivePlanLifecycleMutation(async () => {
			await clearActivePlanStateFile();
		});
	}

	async function writeActivePlanStateFile(
		state: ActivePlanState,
	): Promise<void> {
		await mkdir(workspaceDir, { recursive: true });

		const normalized: ActivePlanState = {
			active_plan: state.active_plan,
			started_at: state.started_at || nowIso(),
			session_ids: uniqueStrings(state.session_ids || []),
			plan_name: state.plan_name || getPlanName(state.active_plan),
			title: state.title,
			description: state.description,
		};

		await Bun.write(activePlanPath, JSON.stringify(normalized, null, 2));
	}

	async function writeActivePlanState(state: ActivePlanState): Promise<void> {
		await withActivePlanLifecycleMutation(async () => {
			await writeActivePlanStateFile(state);
		});
	}

	async function readActivePlanStateInternal(
		sessionID?: string,
	): Promise<ActivePlanState | null> {
		let parsedState: ActivePlanState | null = null;
		const registry = await syncPlanRegistry();

		try {
			const content = await readTextIfExists(activePlanPath);
			if (content) {
				parsedState = normalizeActivePlanState(
					parseJsonWithRecovery(content, activePlanPath),
				);
			}
		} catch {
			parsedState = null;
		}

		const resolveFallbackPlanPath = (excludePath?: string): string | null => {
			const entries = Object.values(registry.plans)
				.filter(
					(entry) =>
						entry.lifecycle !== "archived" && entry.lifecycle !== "draft",
				)
				.filter((entry) => !excludePath || entry.path !== excludePath)
				.sort((a, b) => b.plan_name.localeCompare(a.plan_name));

			return entries[0]?.path || null;
		};

		if (parsedState) {
			const activeEntry = registry.plans[parsedState.plan_name];
			if (activeEntry?.lifecycle === "archived") {
				parsedState = null;
			} else {
				const activePlanContent = await readTextIfExists(
					parsedState.active_plan,
				);
				if (activePlanContent !== null) {
					let shouldRewrite = false;

					if (parsedState.plan_name !== getPlanName(parsedState.active_plan)) {
						parsedState.plan_name = getPlanName(parsedState.active_plan);
						shouldRewrite = true;
					}

					if (sessionID && !parsedState.session_ids.includes(sessionID)) {
						parsedState.session_ids.push(sessionID);
						shouldRewrite = true;
					}

					if (activeEntry && activeEntry.lifecycle !== "active") {
						activeEntry.lifecycle = "active";
						activeEntry.archived_at = undefined;
						activeEntry.updated_at = nowIso();
						await writePlanRegistry(registry);
					}

					if (shouldRewrite) {
						await writeActivePlanStateFile(parsedState);
					}

					return parsedState;
				}
			}
		}

		const fallbackPath = resolveFallbackPlanPath(parsedState?.active_plan);
		if (!fallbackPath) {
			await clearActivePlanStateFile();
			return null;
		}

		const fallbackContent = await readTextIfExists(fallbackPath);
		if (fallbackContent === null) {
			await clearActivePlanStateFile();
			return null;
		}

		const fallbackPlanName = getPlanName(fallbackPath);
		const fallbackMetadata = derivePlanMetadataFallback(
			fallbackPlanName,
			fallbackContent,
		);

		const recovered: ActivePlanState = {
			active_plan: fallbackPath,
			started_at: parsedState?.started_at || nowIso(),
			session_ids: uniqueStrings([
				...(parsedState?.session_ids || []),
				...(sessionID ? [sessionID] : []),
			]),
			plan_name: fallbackPlanName,
			title: parsedState?.title || fallbackMetadata.title,
			description: parsedState?.description || fallbackMetadata.description,
		};

		await writeActivePlanStateFile(recovered);

		const fallbackEntry = registry.plans[fallbackPlanName];
		if (fallbackEntry) {
			fallbackEntry.lifecycle = "active";
			fallbackEntry.archived_at = undefined;
			fallbackEntry.updated_at = nowIso();
			await writePlanRegistry(registry);
		}

		return recovered;
	}

	async function readActivePlanState(
		sessionID?: string,
	): Promise<ActivePlanState | null> {
		return withActivePlanLifecycleMutation(async () =>
			readActivePlanStateInternal(sessionID),
		);
	}

	async function appendSessionToActivePlanInternal(
		sessionID: string,
	): Promise<void> {
		const state = await readActivePlanStateInternal(sessionID);
		if (!state) return;

		if (!state.session_ids.includes(sessionID)) {
			state.session_ids.push(sessionID);
			await writeActivePlanStateFile(state);
		}
	}

	async function appendSessionToActivePlan(sessionID: string): Promise<void> {
		await withActivePlanLifecycleMutation(async () => {
			await appendSessionToActivePlanInternal(sessionID);
		});
	}

	async function resolvePlanPath(identifier: string): Promise<string | null> {
		const value = identifier.trim();
		if (!value) return null;

		const plans = await listPlans();
		if (plans.length === 0) return null;

		const byName = plans.find((p) => {
			const name = getPlanName(p);
			return name === value || `${name}.md` === value;
		});
		if (byName) return byName;

		const bySuffix = plans.find((p) => p.endsWith(value));
		if (bySuffix) return bySuffix;

		return null;
	}

	async function setActivePlanInternal(
		planPath: string,
		options?: {
			sessionID?: string;
			title?: string;
			description?: string;
		},
	): Promise<ActivePlanState> {
		const planContent = await readTextIfExists(planPath);
		if (planContent === null) {
			throw new Error(`Plan not found at ${planPath}`);
		}

		const registry = await syncPlanRegistry();
		const planName = getPlanName(planPath);
		const targetEntry = registry.plans[planName];
		if (targetEntry?.lifecycle === "archived") {
			throw new Error(
				`Plan ${planName} is archived. Unarchive before activating.`,
			);
		}
		if (targetEntry?.lifecycle === "draft") {
			throw new Error(
				`Plan ${planName} is a draft. Promote it before activating.`,
			);
		}

		const previous = await readActivePlanStateInternal();
		const fallbackMetadata = derivePlanMetadataFallback(planName, planContent);

		const nextState: ActivePlanState = {
			active_plan: planPath,
			started_at: nowIso(),
			session_ids: uniqueStrings([
				...(previous?.session_ids || []),
				...(options?.sessionID ? [options.sessionID] : []),
			]),
			plan_name: planName,
			title:
				options?.title ||
				(previous?.active_plan === planPath ? previous.title : undefined) ||
				fallbackMetadata.title,
			description:
				options?.description ||
				(previous?.active_plan === planPath
					? previous.description
					: undefined) ||
				fallbackMetadata.description,
		};

		await writeActivePlanStateFile(nextState);

		const currentTime = nowIso();
		for (const entry of Object.values(registry.plans)) {
			if (entry.lifecycle === "archived" || entry.lifecycle === "draft") {
				if (entry.path === planPath) {
					entry.lifecycle = "active";
					entry.archived_at = undefined;
					entry.updated_at = currentTime;
					entry.title = nextState.title || entry.title;
					entry.description = nextState.description || entry.description;
				}
				continue;
			}
			entry.lifecycle = entry.path === planPath ? "active" : "inactive";
			entry.updated_at = currentTime;
			if (entry.path === planPath) {
				entry.archived_at = undefined;
				entry.title = nextState.title || entry.title;
				entry.description = nextState.description || entry.description;
			}
		}

		if (!registry.plans[planName]) {
			registry.plans[planName] = {
				plan_name: planName,
				path: planPath,
				lifecycle: "active",
				created_at: currentTime,
				updated_at: currentTime,
				title: nextState.title,
				description: nextState.description,
			};
		}

		await writePlanRegistry(registry);
		await syncPlanContext(planName, {
			stage: "active",
			confirmed_by_user: true,
		});
		return nextState;
	}

	async function setActivePlan(
		planPath: string,
		options?: {
			sessionID?: string;
			title?: string;
			description?: string;
		},
	): Promise<ActivePlanState> {
		return withActivePlanLifecycleMutation(async () =>
			setActivePlanInternal(planPath, options),
		);
	}

	async function listPlanRecords(): Promise<PlanRegistryEntry[]> {
		const registry = await syncPlanRegistry();
		return Object.values(registry.plans).sort((a, b) =>
			b.plan_name.localeCompare(a.plan_name),
		);
	}

	async function archivePlanInternal(
		identifier: string,
		options?: { sessionID?: string },
	): Promise<{
		archived: PlanRegistryEntry;
		activePlan: ActivePlanState | null;
	}> {
		const resolved = await resolvePlanPath(identifier);
		if (!resolved) {
			throw new Error(`Plan not found for identifier: ${identifier}`);
		}

		const planName = getPlanName(resolved);
		const registry = await syncPlanRegistry();
		const entry = registry.plans[planName];
		if (!entry) {
			throw new Error(`Plan record not found for ${planName}`);
		}
		const previousLifecycle = entry.lifecycle;
		const existingContext = await readPlanContext(planName);

		entry.lifecycle = "archived";
		entry.archived_at = nowIso();
		entry.updated_at = nowIso();
		await writePlanRegistry(registry);

		const active = await readActivePlanStateInternal();
		let nextActive: ActivePlanState | null = active;

		if (active?.active_plan === resolved) {
			const latestRegistry = await syncPlanRegistry();
			const fallback = Object.values(latestRegistry.plans)
				.filter(
					(record) =>
						record.lifecycle !== "archived" && record.lifecycle !== "draft",
				)
				.filter((record) => record.path !== resolved)
				.sort((a, b) => b.plan_name.localeCompare(a.plan_name))[0];

			if (fallback) {
				nextActive = await setActivePlanInternal(fallback.path, {
					sessionID: options?.sessionID,
				});
			} else {
				await clearActivePlanStateFile();
				nextActive = null;
			}
		}

		await syncPlanContext(planName, {
			stage: "archived",
			confirmed_by_user:
				existingContext?.confirmed_by_user ?? previousLifecycle !== "draft",
		});

		const finalRegistry = await syncPlanRegistry();
		const archived = finalRegistry.plans[planName] || entry;
		return { archived, activePlan: nextActive };
	}

	async function archivePlan(
		identifier: string,
		options?: { sessionID?: string },
	): Promise<{
		archived: PlanRegistryEntry;
		activePlan: ActivePlanState | null;
	}> {
		return withActivePlanLifecycleMutation(async () =>
			archivePlanInternal(identifier, options),
		);
	}

	async function unarchivePlanInternal(
		identifier: string,
	): Promise<PlanRegistryEntry> {
		const resolved = await resolvePlanPath(identifier);
		if (!resolved) {
			throw new Error(`Plan not found for identifier: ${identifier}`);
		}

		const planName = getPlanName(resolved);
		const registry = await syncPlanRegistry();
		const entry = registry.plans[planName];
		if (!entry) {
			throw new Error(`Plan record not found for ${planName}`);
		}

		if (entry.lifecycle === "archived") {
			const existingContext = await readPlanContext(planName);
			entry.lifecycle =
				existingContext && !existingContext.confirmed_by_user
					? "draft"
					: "inactive";
			entry.archived_at = undefined;
			entry.updated_at = nowIso();
			await writePlanRegistry(registry);
			if (existingContext) {
				await writePlanContext({
					...existingContext,
					stage: existingContext.confirmed_by_user ? "confirmed" : "draft",
					updated_at: nowIso(),
				});
			}
		}

		return entry;
	}

	async function unarchivePlan(identifier: string): Promise<PlanRegistryEntry> {
		return withActivePlanLifecycleMutation(async () =>
			unarchivePlanInternal(identifier),
		);
	}

	async function readPlanContext(
		planName: string,
	): Promise<PlanContextRecord | null> {
		const content = await readTextIfExists(getPlanContextPath(planName));
		if (!content) return null;

		const parsed = parseJsonWithRecovery(content, getPlanContextPath(planName));
		if (!parsed) return null;
		return normalizePlanContextRecord(parsed, planName);
	}

	async function writePlanContextFile(
		context: PlanContextRecord,
	): Promise<void> {
		await mkdir(planContextDir, { recursive: true });
		await Bun.write(
			getPlanContextPath(context.plan_name),
			JSON.stringify({ ...context, updated_at: nowIso() }, null, 2),
		);
	}

	async function writePlanContext(context: PlanContextRecord): Promise<void> {
		await withPlanContextMutation(context.plan_name, async () => {
			await writePlanContextFile(context);
		});
	}

	async function syncPlanContext(
		planName: string,
		patch: PlanContextPatch,
	): Promise<PlanContextRecord> {
		return withPlanContextMutation(planName, async () => {
			const existing =
				(await readPlanContext(planName)) ?? createEmptyPlanContext(planName);
			const next: PlanContextRecord = {
				...existing,
				plan_name: planName,
				stage: patch.stage ?? existing.stage,
				confirmed_by_user:
					patch.confirmed_by_user ?? existing.confirmed_by_user,
				goal: patch.goal ?? existing.goal,
				chosen_pattern: patch.chosen_pattern ?? existing.chosen_pattern,
				affected_areas:
					patch.affected_areas !== undefined
						? uniqueStringsOrEmpty(patch.affected_areas)
						: existing.affected_areas,
				blast_radius:
					patch.blast_radius !== undefined
						? uniqueStringsOrEmpty(patch.blast_radius)
						: existing.blast_radius,
				success_criteria:
					patch.success_criteria !== undefined
						? uniqueStringsOrEmpty(patch.success_criteria)
						: existing.success_criteria,
				failure_criteria:
					patch.failure_criteria !== undefined
						? uniqueStringsOrEmpty(patch.failure_criteria)
						: existing.failure_criteria,
				test_plan:
					patch.test_plan !== undefined
						? uniqueStringsOrEmpty(patch.test_plan)
						: existing.test_plan,
				open_risks:
					patch.open_risks !== undefined
						? uniqueStringsOrEmpty(patch.open_risks)
						: existing.open_risks,
				oracle_summary: patch.oracle_summary ?? existing.oracle_summary,
				question_answers: patch.question_answers ?? existing.question_answers,
				pattern_examples: patch.pattern_examples ?? existing.pattern_examples,
				updated_at: nowIso(),
			};

			await writePlanContextFile(next);
			return next;
		});
	}

	async function promotePlanInternal(
		identifier: string,
		options?: {
			sessionID?: string;
		},
	): Promise<ActivePlanState> {
		const resolved = await resolvePlanPath(identifier);
		if (!resolved) {
			throw new Error(`Plan not found for identifier: ${identifier}`);
		}

		const planName = getPlanName(resolved);
		const registry = await syncPlanRegistry();
		const entry = registry.plans[planName];
		if (!entry) {
			throw new Error(`Plan record not found for ${planName}`);
		}
		if (entry.lifecycle === "archived") {
			throw new Error(
				`Plan ${planName} is archived. Unarchive before promoting.`,
			);
		}

		if (entry.lifecycle !== "draft") {
			await syncPlanContext(planName, {
				stage: "confirmed",
				confirmed_by_user: true,
			});
			return await setActivePlanInternal(resolved, {
				sessionID: options?.sessionID,
			});
		}

		entry.lifecycle = "inactive";
		entry.updated_at = nowIso();
		await writePlanRegistry(registry);
		await syncPlanContext(planName, {
			stage: "confirmed",
			confirmed_by_user: true,
		});

		return await setActivePlanInternal(resolved, {
			sessionID: options?.sessionID,
		});
	}

	async function promotePlan(
		identifier: string,
		options?: {
			sessionID?: string;
		},
	): Promise<ActivePlanState> {
		return withActivePlanLifecycleMutation(async () =>
			promotePlanInternal(identifier, options),
		);
	}

	// Notepad helpers
	async function getNotepadDir(): Promise<string | null> {
		const activePlan = await readActivePlanState();
		if (!activePlan) return null;
		return join(notepadsDir, activePlan.plan_name);
	}

	async function ensureNotepadDir(): Promise<string | null> {
		const notepadDir = await getNotepadDir();
		if (!notepadDir) return null;
		await mkdir(notepadDir, { recursive: true });
		return notepadDir;
	}

	async function readNotepadFile(file: NotepadFile): Promise<string | null> {
		const notepadDir = await getNotepadDir();
		if (!notepadDir) return null;

		try {
			const filePath = join(notepadDir, file);
			const content = await readTextIfExists(filePath);
			return content;
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") return null;
			throw error;
		}
	}

	async function appendToNotepadFile(
		file: NotepadFile,
		content: string,
	): Promise<void> {
		const notepadDir = await ensureNotepadDir();
		if (!notepadDir) {
			throw new Error("No active plan. Create a plan first with /plan.");
		}

		const filePath = join(notepadDir, file);
		const timestamp = todayIso();
		const entry = `\n## ${timestamp}\n${content.trim()}\n`;

		const existing = await readTextIfExists(filePath);
		if (existing !== null) {
			await Bun.write(filePath, existing + entry);
			return;
		}

		const title = file.replace(".md", "");
		const header = `# ${title.charAt(0).toUpperCase() + title.slice(1)}\n`;
		await Bun.write(filePath, header + entry);
	}

	// Plan-linked docs helpers
	async function readPlanDocRegistry(): Promise<PlanDocRegistry> {
		try {
			const content = await readTextIfExists(planDocRegistryPath);
			if (!content) {
				return createEmptyPlanDocRegistry();
			}

			const parsed = parseJsonWithRecovery(content, planDocRegistryPath);
			if (!parsed) return createEmptyPlanDocRegistry();
			return normalizePlanDocRegistry(parsed);
		} catch {
			return createEmptyPlanDocRegistry();
		}
	}

	async function writePlanDocRegistry(
		registry: PlanDocRegistry,
	): Promise<void> {
		await mkdir(workspaceDir, { recursive: true });
		await Bun.write(planDocRegistryPath, JSON.stringify(registry, null, 2));
	}

	async function linkPlanDoc(
		planName: string,
		input: LinkPlanDocInput,
	): Promise<PlanDocLink> {
		return withPlanDocRegistryMutation(async () => {
			const registry = await readPlanDocRegistry();

			const existingDoc = Object.values(registry.docs).find(
				(doc) => doc.path === input.path,
			);
			const docID = existingDoc?.id || generateDocID();

			if (!registry.docs[docID]) {
				registry.docs[docID] = {
					id: docID,
					path: input.path,
					type: input.type,
					title: input.title,
					linked_plans: [],
				};
			}

			if (input.title && !registry.docs[docID].title) {
				registry.docs[docID].title = input.title;
			}

			const planLinks = registry.plans[planName] || [];
			const duplicate = planLinks.find(
				(link) =>
					link.id === docID &&
					(link.phase || "") === (input.phase || "") &&
					(link.task || "") === (input.task || ""),
			);

			if (duplicate) {
				return duplicate;
			}

			const link: PlanDocLink = {
				id: docID,
				path: input.path,
				type: input.type,
				title: input.title,
				phase: input.phase,
				task: input.task,
				notes: input.notes,
				linked_at: nowIso(),
			};

			registry.plans[planName] = [...planLinks, link];

			const backlinks = registry.docs[docID].linked_plans;
			const backlinkExists = backlinks.some(
				(backlink) =>
					backlink.plan_name === planName &&
					(backlink.phase || "") === (input.phase || "") &&
					(backlink.task || "") === (input.task || ""),
			);

			if (!backlinkExists) {
				backlinks.push({
					plan_name: planName,
					phase: input.phase,
					task: input.task,
					linked_at: link.linked_at,
				});
			}

			await writePlanDocRegistry(registry);
			return link;
		});
	}

	async function getPlanDocLinks(planName: string): Promise<PlanDocLink[]> {
		const registry = await readPlanDocRegistry();
		return registry.plans[planName] || [];
	}

	async function getPlanDocByID(id: string): Promise<PlanDocIndexEntry | null> {
		const registry = await readPlanDocRegistry();
		return registry.docs[id] || null;
	}

	return {
		readActivePlanState,
		writeActivePlanState,
		clearActivePlanState,
		appendSessionToActivePlan,
		resolvePlanPath,
		setActivePlan,
		listPlanRecords,
		archivePlan,
		unarchivePlan,
		readPlanRegistry,
		writePlanRegistry,
		syncPlanRegistry,
		upsertPlanRegistryEntry,
		getNotepadDir,
		ensureNotepadDir,
		readNotepadFile,
		appendToNotepadFile,
		listPlans,
		readPlanContext,
		writePlanContext,
		syncPlanContext,
		promotePlan,
		readPlanDocRegistry,
		writePlanDocRegistry,
		linkPlanDoc,
		getPlanDocLinks,
		getPlanDocByID,
	};
}

// ==========================================
// METADATA GENERATION
// ==========================================

/**
 * Generate metadata (title/description) for a plan using small_model.
 * Falls back to extraction from plan content if small_model is not configured.
 */
interface PlanMetadataClient {
	config: {
		get: () => Promise<{ data?: unknown }>;
	};
	session: {
		create: (input: {
			body?: {
				title?: string;
				parentID?: string;
			};
		}) => Promise<{ data?: unknown }>;
		prompt: (input: {
			path: { id: string };
			body: {
				parts: Array<{ type: "text"; text: string }>;
			};
		}) => Promise<{ data?: unknown }>;
	};
}

export async function generatePlanMetadata(
	client: PlanMetadataClient,
	planContent: string,
	parentSessionID?: string,
): Promise<PlanMetadata> {
	const fallbackMetadata = (): PlanMetadata => {
		const goalMatch = planContent.match(/## Goal\n\n?([^\n#]+)/);
		const goal = goalMatch?.[1]?.trim();

		if (goal) {
			const title = goal.length > 40 ? `${goal.slice(0, 37)}...` : goal;
			const description = goal.length > 150 ? `${goal.slice(0, 147)}...` : goal;
			return { title, description };
		}

		const firstLine =
			planContent
				.split("\n")
				.find((line) => line.trim().length > 0 && !line.startsWith("---")) ||
			"Implementation Plan";
		const title = firstLine.replace(/^#+ /, "").slice(0, 40).trim();
		const description =
			planContent.slice(0, 150).trim() +
			(planContent.length > 150 ? "..." : "");
		return { title, description };
	};

	try {
		const config = await client.config.get();
		const configData = config.data as { small_model?: string } | undefined;

		if (!configData?.small_model) {
			return fallbackMetadata();
		}

		const session = await client.session.create({
			body: {
				title: "Plan Metadata Generation",
				parentID: parentSessionID,
			},
		});
		const sessionData = session.data as { id?: string } | undefined;

		if (!sessionData?.id) {
			return fallbackMetadata();
		}

		const prompt = `Generate a title and description for this implementation plan.

RULES:
- Title: 3-6 words, max 40 characters, describe the main goal
- Description: 1-2 sentences, max 150 characters, summarize what will be built

PLAN CONTENT:
${planContent.slice(0, 3000)}

Respond with ONLY valid JSON in this exact format:
{"title": "Your Title Here", "description": "Your description here."}`;

		const PROMPT_TIMEOUT_MS = 15000;
		const result = await Promise.race([
			client.session.prompt({
				path: { id: sessionData.id },
				body: {
					parts: [{ type: "text" as const, text: prompt }],
				},
			}),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("Prompt timeout")),
					PROMPT_TIMEOUT_MS,
				),
			),
		]);

		const resultData = (result as { data?: unknown }).data as
			| { parts?: Array<{ type: string; text?: string }> }
			| undefined;
		const responseParts = resultData?.parts;
		const textPart = responseParts?.find(
			(part) => part.type === "text" && typeof part.text === "string",
		);

		if (!textPart?.text) {
			return fallbackMetadata();
		}

		const jsonMatch = textPart.text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return fallbackMetadata();
		}

		const parsed = JSON.parse(jsonMatch[0]) as {
			title?: string;
			description?: string;
		};
		if (!parsed.title || !parsed.description) {
			return fallbackMetadata();
		}

		return {
			title: parsed.title.slice(0, 40),
			description: parsed.description.slice(0, 150),
		};
	} catch {
		return fallbackMetadata();
	}
}
