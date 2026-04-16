import { rename } from "node:fs/promises";
import { join } from "./bun-compat.js";
import { createLogger } from "./logging.js";
import {
	type DelegationCategory,
	type DelegationRoutingTelemetry,
	parseDelegationCategory,
} from "./router.js";
import { isSystemError } from "./utils.js";

const logger = createLogger("delegation.state");

export type TaskStatus =
	| "queued"
	| "blocked"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export type TaskMergeStatus =
	| "pending"
	| "verified"
	| "deferred"
	| "merged"
	| "conflicted"
	| "dirty_root"
	| "failed"
	| "bypassed";

export type TaskVerificationStatus =
	| "pending"
	| "passed"
	| "failed"
	| "not_required";

export type TaskVerificationStrategy = "targeted" | "fallback" | "not_required";
export type TaskRootFollowThroughStatus = "pending" | "delivered" | "waived";

export interface TaskModelSelection {
	providerID: string;
	modelID: string;
	variant?: string;
}

export type TaskAssignmentOwner = "manager";
export type TaskAssignmentWorkflow = "caid";
export type TaskRetryReason = "merge_conflict" | "dirty_root";
export type TaskRetryState = "idle" | "blocked" | "resync_required" | "ready";
export type TaskResyncStatus = "pending" | "succeeded" | "failed";
export type TaskReviewStatus =
	| "not_required"
	| "pending"
	| "running"
	| "complete"
	| "blocked";

export interface TaskAssignmentRetryRecord {
	reason?: TaskRetryReason;
	state?: TaskRetryState;
	last_resync_status?: TaskResyncStatus;
	last_resync_at?: string;
	last_resync_summary?: string;
}

export interface TaskAssignmentVerificationRecord {
	strategy?: TaskVerificationStrategy;
	candidate_commands?: string[];
	selected_command?: string;
	fallback_command?: string;
	selection_reason?: string;
}

export interface TaskAssignmentReviewRecord {
	status?: TaskReviewStatus;
	summary?: string;
	reviewed_at?: string;
}

export interface TaskAssignmentRecord {
	owner: TaskAssignmentOwner;
	workflow: TaskAssignmentWorkflow;
	dependency_ids?: string[];
	retry?: TaskAssignmentRetryRecord;
	verification?: TaskAssignmentVerificationRecord;
	review?: TaskAssignmentReviewRecord;
}

export interface TaskExecutionRecord {
	mode: "direct" | "worktree";
	branch?: string;
	base_branch?: string;
	worktree_path?: string;
	effective_root_path?: string;
	merge_status?: TaskMergeStatus;
	verification_status?: TaskVerificationStatus;
	verification_strategy?: TaskVerificationStrategy;
	verification_candidates?: string[];
	verification_fallback_reason?: string;
	verification_command?: string;
	verification_summary?: string;
	diff_summary?: string;
	root_follow_through?: {
		status: TaskRootFollowThroughStatus;
		updated_at: string;
		reason?: string;
		source?: string;
	};
	read_count?: number;
	search_count?: number;
	planning_count?: number;
	edit_count?: number;
	other_count?: number;
	file_changed?: boolean;
	edit_or_blocked_threshold?: number;
	stale_reason?: string;
	retry_count?: number;
}

export interface TaskRecord {
	id: string;
	root_session_id: string;
	parent_session_id: string;
	child_session_id: string;
	root_model?: TaskModelSelection;
	description: string;
	agent: string;
	prompt: string;
	authoritative_context?: string;
	command?: string;
	category?: DelegationCategory;
	routing?: DelegationRoutingTelemetry;
	depends_on?: string[];
	concurrency_key?: string;
	assignment?: TaskAssignmentRecord;
	execution?: TaskExecutionRecord;
	run_in_background: boolean;
	status: TaskStatus;
	created_order?: number;
	created_at: string;
	updated_at: string;
	started_at?: string;
	completed_at?: string;
	result?: string;
	error?: string;
}

interface TaskStore {
	version: 3;
	delegations: Record<string, TaskRecord>;
}

const TASKS_FILENAME = "task-records.json";
const LEGACY_TASKS_FILENAME = "delegations.json";

const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	queued: ["blocked", "running", "failed", "cancelled"],
	blocked: ["queued", "running", "failed", "cancelled"],
	running: ["blocked", "succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

function nowIso(): string {
	return new Date().toISOString();
}

function parseCreatedOrder(value: unknown): number | undefined {
	return Number.isInteger(value) && (value as number) > 0
		? (value as number)
		: undefined;
}

function compareTaskCreationAscending(a: TaskRecord, b: TaskRecord): number {
	if (
		typeof a.created_order === "number" &&
		typeof b.created_order === "number" &&
		a.created_order !== b.created_order
	) {
		return a.created_order - b.created_order;
	}

	if (a.created_at === b.created_at) {
		return a.id.localeCompare(b.id);
	}

	return a.created_at.localeCompare(b.created_at);
}

function compareTaskCreationDescending(a: TaskRecord, b: TaskRecord): number {
	return compareTaskCreationAscending(b, a);
}

function getNextCreatedOrder(store: TaskStore): number {
	let maxOrder = 0;
	for (const record of Object.values(store.delegations)) {
		maxOrder = Math.max(maxOrder, record.created_order ?? 0);
	}

	return maxOrder + 1;
}

function createEmptyStore(): TaskStore {
	return {
		version: 3,
		delegations: {},
	};
}

function parseJson(content: string): unknown | null {
	const normalized = content.replace(/^\uFEFF/, "").trim();
	if (!normalized) return null;

	try {
		return JSON.parse(normalized);
	} catch {
		const withoutTrailingCommas = normalized.replace(/,\s*([}\]])/g, "$1");
		if (withoutTrailingCommas !== normalized) {
			try {
				logger.warn("Recovered task store JSON with trailing comma cleanup");
				return JSON.parse(withoutTrailingCommas);
			} catch {
				// continue
			}
		}

		const objectStart = withoutTrailingCommas.indexOf("{");
		const objectEnd = withoutTrailingCommas.lastIndexOf("}");
		if (objectStart >= 0 && objectEnd > objectStart) {
			try {
				logger.warn("Recovered task store JSON by object boundary extraction");
				return JSON.parse(
					withoutTrailingCommas.slice(objectStart, objectEnd + 1),
				);
			} catch {
				// continue
			}
		}

		const arrayStart = withoutTrailingCommas.indexOf("[");
		const arrayEnd = withoutTrailingCommas.lastIndexOf("]");
		if (arrayStart >= 0 && arrayEnd > arrayStart) {
			try {
				logger.warn("Recovered task store JSON by array boundary extraction");
				return JSON.parse(
					withoutTrailingCommas.slice(arrayStart, arrayEnd + 1),
				);
			} catch {
				// continue
			}
		}

		logger.warn("Failed to parse task store JSON");
		return null;
	}
}

function parseTaskStatus(value: unknown): TaskStatus | null {
	if (value === "queued") return "queued";
	if (value === "blocked") return "blocked";
	if (value === "running") return "running";
	if (value === "succeeded") return "succeeded";
	if (value === "failed") return "failed";
	if (value === "cancelled") return "cancelled";
	return null;
}

function normalizeDependencyIDs(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const normalized = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (normalized.length === 0) return undefined;
	return [...new Set(normalized)];
}

function normalizeCommandList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const normalized = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (normalized.length === 0) return undefined;
	return [...new Set(normalized)];
}

function parseTaskAssignmentOwner(value: unknown): TaskAssignmentOwner | null {
	if (value === "manager") return "manager";
	return null;
}

function parseTaskAssignmentWorkflow(
	value: unknown,
): TaskAssignmentWorkflow | null {
	if (value === "caid") return "caid";
	return null;
}

function parseTaskRetryReason(value: unknown): TaskRetryReason | undefined {
	if (value === "merge_conflict") return "merge_conflict";
	if (value === "dirty_root") return "dirty_root";
	return undefined;
}

function parseTaskRetryState(value: unknown): TaskRetryState | undefined {
	if (value === "idle") return "idle";
	if (value === "blocked") return "blocked";
	if (value === "resync_required") return "resync_required";
	if (value === "ready") return "ready";
	return undefined;
}

function parseTaskResyncStatus(value: unknown): TaskResyncStatus | undefined {
	if (value === "pending") return "pending";
	if (value === "succeeded") return "succeeded";
	if (value === "failed") return "failed";
	return undefined;
}

function parseTaskReviewStatus(value: unknown): TaskReviewStatus | undefined {
	if (value === "not_required") return "not_required";
	if (value === "pending") return "pending";
	if (value === "running") return "running";
	if (value === "complete") return "complete";
	if (value === "blocked") return "blocked";
	return undefined;
}

function parseTaskVerificationStrategy(
	value: unknown,
): TaskVerificationStrategy | undefined {
	if (value === "targeted") return "targeted";
	if (value === "fallback") return "fallback";
	if (value === "not_required") return "not_required";
	return undefined;
}

function parseTaskRootFollowThroughStatus(
	value: unknown,
): TaskRootFollowThroughStatus | undefined {
	if (value === "pending") return "pending";
	if (value === "delivered") return "delivered";
	if (value === "waived") return "waived";
	return undefined;
}

function normalizeTaskAssignment(
	value: unknown,
): TaskAssignmentRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const owner = parseTaskAssignmentOwner(raw.owner);
	const workflow = parseTaskAssignmentWorkflow(raw.workflow);
	if (!owner || !workflow) return undefined;

	const retryRaw =
		raw.retry && typeof raw.retry === "object"
			? (raw.retry as Record<string, unknown>)
			: undefined;
	const retry: TaskAssignmentRetryRecord | undefined = retryRaw
		? {
				...(parseTaskRetryReason(retryRaw.reason)
					? { reason: parseTaskRetryReason(retryRaw.reason) }
					: {}),
				...(parseTaskRetryState(retryRaw.state)
					? { state: parseTaskRetryState(retryRaw.state) }
					: {}),
				...(parseTaskResyncStatus(retryRaw.last_resync_status)
					? {
							last_resync_status: parseTaskResyncStatus(
								retryRaw.last_resync_status,
							),
						}
					: {}),
				...(typeof retryRaw.last_resync_at === "string"
					? { last_resync_at: retryRaw.last_resync_at }
					: {}),
				...(typeof retryRaw.last_resync_summary === "string"
					? { last_resync_summary: retryRaw.last_resync_summary }
					: {}),
			}
		: undefined;

	const verificationRaw =
		raw.verification && typeof raw.verification === "object"
			? (raw.verification as Record<string, unknown>)
			: undefined;
	const verification: TaskAssignmentVerificationRecord | undefined =
		verificationRaw
			? {
					...(parseTaskVerificationStrategy(verificationRaw.strategy)
						? {
								strategy: parseTaskVerificationStrategy(
									verificationRaw.strategy,
								),
							}
						: {}),
					...(normalizeCommandList(verificationRaw.candidate_commands)
						? {
								candidate_commands: normalizeCommandList(
									verificationRaw.candidate_commands,
								),
							}
						: {}),
					...(typeof verificationRaw.selected_command === "string"
						? { selected_command: verificationRaw.selected_command }
						: {}),
					...(typeof verificationRaw.fallback_command === "string"
						? { fallback_command: verificationRaw.fallback_command }
						: {}),
					...(typeof verificationRaw.selection_reason === "string"
						? { selection_reason: verificationRaw.selection_reason }
						: {}),
				}
			: undefined;

	const reviewRaw =
		raw.review && typeof raw.review === "object"
			? (raw.review as Record<string, unknown>)
			: undefined;
	const review: TaskAssignmentReviewRecord | undefined = reviewRaw
		? {
				...(parseTaskReviewStatus(reviewRaw.status)
					? { status: parseTaskReviewStatus(reviewRaw.status) }
					: {}),
				...(typeof reviewRaw.summary === "string"
					? { summary: reviewRaw.summary }
					: {}),
				...(typeof reviewRaw.reviewed_at === "string"
					? { reviewed_at: reviewRaw.reviewed_at }
					: {}),
			}
		: undefined;

	return {
		owner,
		workflow,
		...(normalizeDependencyIDs(raw.dependency_ids)
			? { dependency_ids: normalizeDependencyIDs(raw.dependency_ids) }
			: {}),
		...(retry && Object.keys(retry).length > 0 ? { retry } : {}),
		...(verification && Object.keys(verification).length > 0
			? { verification }
			: {}),
		...(review && Object.keys(review).length > 0 ? { review } : {}),
	};
}

function sameStringSet(left?: string[], right?: string[]): boolean {
	const leftValues = [...new Set(left ?? [])].sort();
	const rightValues = [...new Set(right ?? [])].sort();
	if (leftValues.length !== rightValues.length) return false;
	return leftValues.every((value, index) => value === rightValues[index]);
}

function normalizeTaskAssignmentInput(
	assignment: TaskAssignmentRecord | undefined,
	dependsOn: string[] | undefined,
): TaskAssignmentRecord | undefined {
	if (!assignment) return undefined;

	const dependencyIDs = assignment.dependency_ids ?? dependsOn;
	if (
		assignment.dependency_ids &&
		dependsOn &&
		!sameStringSet(assignment.dependency_ids, dependsOn)
	) {
		throw new Error(
			"Manager-owned assignment dependencies must match the task dependency set.",
		);
	}

	return {
		...assignment,
		...(dependencyIDs && dependencyIDs.length > 0
			? { dependency_ids: dependencyIDs }
			: {}),
	};
}

export function isManagerOwnedCAIDTask(
	record: Pick<TaskRecord, "assignment">,
): boolean {
	return (
		record.assignment?.owner === "manager" &&
		record.assignment.workflow === "caid"
	);
}

function parseRoutingFallbackPath(
	value: unknown,
): DelegationRoutingTelemetry["fallback_path"] | null {
	if (value === "none") return "none";
	if (value === "category-default") return "category-default";
	if (value === "frontend-reroute") return "frontend-reroute";
	if (value === "user-subagent") return "user-subagent";
	if (value === "keyword-fallback") return "keyword-fallback";
	return null;
}

function normalizeRoutingTelemetry(
	value: unknown,
): DelegationRoutingTelemetry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const detectedCategory = parseDelegationCategory(
		typeof raw.detected_category === "string"
			? raw.detected_category
			: undefined,
	);
	if (!detectedCategory) return undefined;

	if (typeof raw.chosen_agent !== "string" || raw.chosen_agent.length === 0) {
		return undefined;
	}

	if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
		return undefined;
	}

	const fallbackPath = parseRoutingFallbackPath(raw.fallback_path);
	if (!fallbackPath) return undefined;

	return {
		detected_category: detectedCategory,
		chosen_agent: raw.chosen_agent,
		confidence: Math.max(0, Math.min(1, raw.confidence)),
		fallback_path: fallbackPath,
	};
}

function normalizeTaskExecution(
	value: unknown,
): TaskExecutionRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.mode !== "direct" && raw.mode !== "worktree") return undefined;

	return {
		mode: raw.mode,
		branch: typeof raw.branch === "string" ? raw.branch : undefined,
		base_branch:
			typeof raw.base_branch === "string" ? raw.base_branch : undefined,
		effective_root_path:
			typeof raw.effective_root_path === "string"
				? raw.effective_root_path
				: undefined,
		worktree_path:
			typeof raw.worktree_path === "string" ? raw.worktree_path : undefined,
		merge_status:
			typeof raw.merge_status === "string"
				? (raw.merge_status as TaskMergeStatus)
				: undefined,
		verification_status:
			typeof raw.verification_status === "string"
				? (raw.verification_status as TaskVerificationStatus)
				: undefined,
		verification_strategy: parseTaskVerificationStrategy(
			raw.verification_strategy,
		),
		verification_candidates: normalizeCommandList(raw.verification_candidates),
		verification_fallback_reason:
			typeof raw.verification_fallback_reason === "string"
				? raw.verification_fallback_reason
				: undefined,
		verification_command:
			typeof raw.verification_command === "string"
				? raw.verification_command
				: undefined,
		verification_summary:
			typeof raw.verification_summary === "string"
				? raw.verification_summary
				: undefined,
		diff_summary:
			typeof raw.diff_summary === "string" ? raw.diff_summary : undefined,
		root_follow_through:
			raw.root_follow_through && typeof raw.root_follow_through === "object"
				? (() => {
						const followThrough = raw.root_follow_through as Record<
							string,
							unknown
						>;
						const status = parseTaskRootFollowThroughStatus(
							followThrough.status,
						);
						if (!status) return undefined;

						return {
							status,
							updated_at:
								typeof followThrough.updated_at === "string"
									? followThrough.updated_at
									: nowIso(),
							reason:
								typeof followThrough.reason === "string"
									? followThrough.reason
									: undefined,
							source:
								typeof followThrough.source === "string"
									? followThrough.source
									: undefined,
						};
					})()
				: undefined,
		read_count:
			Number.isInteger(raw.read_count) && (raw.read_count as number) >= 0
				? (raw.read_count as number)
				: undefined,
		search_count:
			Number.isInteger(raw.search_count) && (raw.search_count as number) >= 0
				? (raw.search_count as number)
				: undefined,
		planning_count:
			Number.isInteger(raw.planning_count) &&
			(raw.planning_count as number) >= 0
				? (raw.planning_count as number)
				: undefined,
		edit_count:
			Number.isInteger(raw.edit_count) && (raw.edit_count as number) >= 0
				? (raw.edit_count as number)
				: undefined,
		other_count:
			Number.isInteger(raw.other_count) && (raw.other_count as number) >= 0
				? (raw.other_count as number)
				: undefined,
		file_changed:
			typeof raw.file_changed === "boolean" ? raw.file_changed : undefined,
		edit_or_blocked_threshold:
			Number.isInteger(raw.edit_or_blocked_threshold) &&
			(raw.edit_or_blocked_threshold as number) >= 0
				? (raw.edit_or_blocked_threshold as number)
				: undefined,
		stale_reason:
			typeof raw.stale_reason === "string" ? raw.stale_reason : undefined,
		retry_count:
			Number.isInteger(raw.retry_count) && (raw.retry_count as number) >= 0
				? (raw.retry_count as number)
				: undefined,
	};
}

function normalizeTaskModelSelection(
	value: unknown,
): TaskModelSelection | undefined {
	if (!value || typeof value !== "object") return undefined;

	const raw = value as Record<string, unknown>;
	const providerID =
		typeof raw.providerID === "string"
			? raw.providerID
			: typeof raw.providerId === "string"
				? raw.providerId
				: typeof raw.provider_id === "string"
					? raw.provider_id
					: undefined;
	const modelID =
		typeof raw.modelID === "string"
			? raw.modelID
			: typeof raw.modelId === "string"
				? raw.modelId
				: typeof raw.model_id === "string"
					? raw.model_id
					: undefined;

	if (!providerID || !modelID) return undefined;

	return {
		providerID,
		modelID,
		variant: typeof raw.variant === "string" ? raw.variant : undefined,
	};
}

function normalizeTaskRecord(value: unknown): TaskRecord | null {
	if (!value || typeof value !== "object") return null;

	const raw = value as Record<string, unknown>;
	const status = parseTaskStatus(raw.status);
	if (!status) return null;

	if (typeof raw.id !== "string") return null;
	if (typeof raw.root_session_id !== "string") return null;
	if (typeof raw.parent_session_id !== "string") return null;
	if (typeof raw.child_session_id !== "string") return null;
	if (typeof raw.description !== "string") return null;
	if (typeof raw.agent !== "string") return null;
	if (typeof raw.prompt !== "string") return null;
	if (typeof raw.run_in_background !== "boolean") return null;

	const category = parseDelegationCategory(
		typeof raw.category === "string" ? raw.category : undefined,
	);

	return {
		id: raw.id,
		root_session_id: raw.root_session_id,
		parent_session_id: raw.parent_session_id,
		child_session_id: raw.child_session_id,
		root_model: normalizeTaskModelSelection(raw.root_model ?? raw.model),
		description: raw.description,
		agent: raw.agent,
		prompt: raw.prompt,
		authoritative_context:
			typeof raw.authoritative_context === "string"
				? raw.authoritative_context
				: undefined,
		command: typeof raw.command === "string" ? raw.command : undefined,
		category: category ?? undefined,
		routing: normalizeRoutingTelemetry(raw.routing),
		depends_on: normalizeDependencyIDs(raw.depends_on),
		concurrency_key:
			typeof raw.concurrency_key === "string" ? raw.concurrency_key : undefined,
		assignment: normalizeTaskAssignment(raw.assignment),
		execution: normalizeTaskExecution(raw.execution),
		run_in_background: raw.run_in_background,
		status,
		created_order: parseCreatedOrder(raw.created_order),
		created_at: typeof raw.created_at === "string" ? raw.created_at : nowIso(),
		updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
		started_at: typeof raw.started_at === "string" ? raw.started_at : undefined,
		completed_at:
			typeof raw.completed_at === "string" ? raw.completed_at : undefined,
		result: typeof raw.result === "string" ? raw.result : undefined,
		error: typeof raw.error === "string" ? raw.error : undefined,
	};
}

function normalizeStore(value: unknown): TaskStore {
	if (!value || typeof value !== "object") return createEmptyStore();

	const raw = value as Record<string, unknown>;
	if (raw.version !== 3) return createEmptyStore();
	const tasksRaw = raw.delegations;
	if (!tasksRaw || typeof tasksRaw !== "object") {
		return createEmptyStore();
	}

	const delegations: Record<string, TaskRecord> = {};
	for (const [id, entry] of Object.entries(
		tasksRaw as Record<string, unknown>,
	)) {
		const record = normalizeTaskRecord(entry);
		if (!record) continue;
		delegations[id] = record;
	}

	return {
		version: 3,
		delegations,
	};
}

function isTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].includes(to);
}

function withTransitionGuard(record: TaskRecord, nextStatus: TaskStatus): void {
	if (isTransitionAllowed(record.status, nextStatus)) return;

	throw new Error(
		`Invalid task transition: ${record.status} -> ${nextStatus} for ${record.id}`,
	);
}

function hasDependencyPath(
	store: TaskStore,
	fromID: string,
	targetID: string,
	seen: Set<string>,
): boolean {
	if (fromID === targetID) return true;
	if (seen.has(fromID)) return false;
	seen.add(fromID);

	const record = store.delegations[fromID];
	if (!record?.depends_on || record.depends_on.length === 0) return false;

	for (const depID of record.depends_on) {
		if (hasDependencyPath(store, depID, targetID, seen)) {
			return true;
		}
	}

	return false;
}

function hasDependencyCycle(
	store: TaskStore,
	candidateID: string,
	dependsOn: string[],
): boolean {
	for (const depID of dependsOn) {
		if (depID === candidateID) return true;
		if (hasDependencyPath(store, depID, candidateID, new Set())) {
			return true;
		}
	}

	return false;
}

function collectBlockingDependencies(
	store: TaskStore,
	record: Pick<TaskRecord, "depends_on">,
): string[] {
	if (!record.depends_on || record.depends_on.length === 0) return [];

	const blockers: string[] = [];
	for (const dependencyID of record.depends_on) {
		const dependency = store.delegations[dependencyID];
		if (!dependency || dependency.status !== "succeeded") {
			blockers.push(dependencyID);
		}
	}

	return blockers;
}

function dependencyDepth(
	store: TaskStore,
	record: TaskRecord,
	seen: Set<string> = new Set(),
): number {
	if (seen.has(record.id)) return 0;
	seen.add(record.id);

	const dependencyIDs = record.depends_on ?? [];
	if (dependencyIDs.length === 0) return 0;

	let maxDepth = 0;
	for (const dependencyID of dependencyIDs) {
		const dependency = store.delegations[dependencyID];
		if (!dependency) continue;
		maxDepth = Math.max(maxDepth, dependencyDepth(store, dependency, seen) + 1);
	}

	return maxDepth;
}

function isPromotableTask(store: TaskStore, record: TaskRecord): boolean {
	if (record.status !== "queued" && record.status !== "blocked") return false;
	if (collectBlockingDependencies(store, record).length > 0) return false;

	if (!isManagerOwnedCAIDTask(record)) {
		return !(
			record.status === "blocked" &&
			record.execution?.merge_status === "conflicted"
		);
	}

	const reviewStatus = record.assignment?.review?.status;
	if (
		reviewStatus === "pending" ||
		reviewStatus === "running" ||
		reviewStatus === "blocked"
	) {
		return false;
	}

	const retryState = record.assignment?.retry?.state;
	if (retryState === "blocked" || retryState === "resync_required") {
		return false;
	}

	return true;
}

function comparePromotableTasks(
	store: TaskStore,
	a: TaskRecord,
	b: TaskRecord,
) {
	const aManager = isManagerOwnedCAIDTask(a);
	const bManager = isManagerOwnedCAIDTask(b);

	if (aManager && bManager) {
		const depthDifference =
			dependencyDepth(store, a) - dependencyDepth(store, b);
		if (depthDifference !== 0) return depthDifference;
	}

	if (aManager !== bManager) {
		return aManager ? -1 : 1;
	}

	return compareTaskCreationAscending(a, b);
}

export function createTaskStateManager(
	workspaceDir: string,
	logger = createLogger("delegation.state"),
) {
	const tasksPath = join(workspaceDir, TASKS_FILENAME);
	const legacyTasksPath = join(workspaceDir, LEGACY_TASKS_FILENAME);
	let mutationQueue: Promise<void> = Promise.resolve();

	async function readStoreFile(pathValue: string): Promise<TaskStore | null> {
		try {
			const file = Bun.file(pathValue);
			if (!(await file.exists())) return null;

			const text = await file.text();
			if (!text.trim()) return createEmptyStore();

			const parsed = parseJson(text);
			if (!parsed) return createEmptyStore();

			return normalizeStore(parsed);
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}

	async function readStore(): Promise<TaskStore> {
		const primary = await readStoreFile(tasksPath);
		if (primary) return primary;

		const legacy = await readStoreFile(legacyTasksPath);
		if (!legacy) return createEmptyStore();
		if (Object.keys(legacy.delegations).length === 0) return createEmptyStore();

		await writeStore(legacy);
		logger.info("Migrated legacy task records store", {
			source: legacyTasksPath,
			target: tasksPath,
		});
		return legacy;
	}

	async function writeStore(store: TaskStore): Promise<void> {
		const nextPayload = JSON.stringify(store, null, 2);
		const tmpPath = `${tasksPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		try {
			await Bun.write(tmpPath, nextPayload);
			await rename(tmpPath, tasksPath);
		} catch (error) {
			await Bun.file(tmpPath)
				.delete()
				.catch(() => undefined);
			throw error;
		}
	}

	async function withStoreMutation<T>(
		mutator: (store: TaskStore) => Promise<T> | T,
	): Promise<T> {
		const run = async (): Promise<T> => {
			const store = await readStore();
			const result = await mutator(store);
			await writeStore(store);
			return result;
		};

		const queuedRun = mutationQueue.then(run, run);
		mutationQueue = queuedRun.then(
			() => undefined,
			() => undefined,
		);

		return queuedRun;
	}

	async function createTask(input: {
		id: string;
		root_session_id: string;
		parent_session_id: string;
		child_session_id: string;
		root_model?: TaskModelSelection;
		description: string;
		agent: string;
		prompt: string;
		authoritative_context?: string;
		command?: string;
		category?: DelegationCategory;
		routing?: DelegationRoutingTelemetry;
		depends_on?: string[];
		concurrency_key?: string;
		assignment?: TaskAssignmentRecord;
		execution?: TaskExecutionRecord;
		run_in_background: boolean;
		initial_status?: "queued" | "blocked" | "running";
	}): Promise<TaskRecord> {
		return withStoreMutation((store) => {
			if (store.delegations[input.id]) {
				throw new Error(`Task ${input.id} already exists`);
			}

			const dependencies = input.depends_on
				? [...new Set(input.depends_on.map((entry) => entry.trim()))].filter(
						(entry) => entry.length > 0,
					)
				: [];

			for (const dependencyID of dependencies) {
				const dependency = store.delegations[dependencyID];
				if (!dependency) {
					throw new Error(`Task dependency '${dependencyID}' was not found.`);
				}

				if (dependency.root_session_id !== input.root_session_id) {
					throw new Error(
						`Task dependency '${dependencyID}' is outside the root session scope.`,
					);
				}
			}

			if (hasDependencyCycle(store, input.id, dependencies)) {
				throw new Error(
					`Dependency cycle detected while creating task '${input.id}'.`,
				);
			}

			const blockers = collectBlockingDependencies(store, {
				depends_on: dependencies,
			});

			const initialStatus =
				input.initial_status ?? (blockers.length > 0 ? "blocked" : "queued");
			const createdAt = nowIso();
			const createdOrder = getNextCreatedOrder(store);
			const startedAt = initialStatus === "running" ? createdAt : undefined;
			const assignment = normalizeTaskAssignmentInput(
				input.assignment,
				dependencies,
			);
			const record: TaskRecord = {
				id: input.id,
				root_session_id: input.root_session_id,
				parent_session_id: input.parent_session_id,
				child_session_id: input.child_session_id,
				root_model: input.root_model,
				description: input.description,
				agent: input.agent,
				prompt: input.prompt,
				authoritative_context: input.authoritative_context,
				command: input.command,
				category: input.category,
				routing: input.routing,
				depends_on: dependencies.length > 0 ? dependencies : undefined,
				concurrency_key: input.concurrency_key,
				assignment,
				execution: input.execution,
				run_in_background: input.run_in_background,
				status: initialStatus,
				created_order: createdOrder,
				created_at: createdAt,
				updated_at: createdAt,
				started_at: startedAt,
			};

			store.delegations[input.id] = record;
			return record;
		});
	}

	async function transitionTask(
		id: string,
		nextStatus: TaskStatus,
		patch?: { result?: string; error?: string },
	): Promise<TaskRecord> {
		return withStoreMutation((store) => {
			const current = store.delegations[id];
			if (!current) throw new Error(`Task ${id} not found`);

			if (current.status === nextStatus) {
				const updated: TaskRecord = {
					...current,
					updated_at: nowIso(),
					result:
						typeof patch?.result === "string" ? patch.result : current.result,
					error: typeof patch?.error === "string" ? patch.error : current.error,
				};
				store.delegations[id] = updated;
				return updated;
			}

			withTransitionGuard(current, nextStatus);

			const updatedAt = nowIso();
			const shouldSetStarted =
				nextStatus === "running" &&
				(!current.started_at || current.started_at === "");
			const isTerminal =
				nextStatus === "succeeded" ||
				nextStatus === "failed" ||
				nextStatus === "cancelled";

			const nextRecord: TaskRecord = {
				...current,
				status: nextStatus,
				updated_at: updatedAt,
				started_at: shouldSetStarted ? updatedAt : current.started_at,
				completed_at: isTerminal ? updatedAt : current.completed_at,
				result:
					typeof patch?.result === "string" ? patch.result : current.result,
				error: typeof patch?.error === "string" ? patch.error : current.error,
			};

			store.delegations[id] = nextRecord;
			return nextRecord;
		});
	}

	async function restartTask(input: {
		id: string;
		child_session_id?: string;
		root_model?: TaskModelSelection;
		description?: string;
		prompt: string;
		authoritative_context?: string;
		command?: string;
		category?: DelegationCategory;
		routing?: DelegationRoutingTelemetry;
		depends_on?: string[];
		concurrency_key?: string;
		assignment?: TaskAssignmentRecord;
		execution?: TaskExecutionRecord;
		run_in_background: boolean;
		initial_status?: "queued" | "blocked" | "running";
	}): Promise<TaskRecord> {
		return withStoreMutation((store) => {
			const current = store.delegations[input.id];
			if (!current) throw new Error(`Task ${input.id} not found`);
			if (current.status === "queued" || current.status === "running") {
				throw new Error(`Task ${input.id} is already active.`);
			}

			const dependencies = input.depends_on ?? current.depends_on;
			const blockers = collectBlockingDependencies(store, {
				depends_on: dependencies,
			});
			const nextStatus =
				input.initial_status ?? (blockers.length > 0 ? "blocked" : "queued");
			const updatedAt = nowIso();
			const assignment = normalizeTaskAssignmentInput(
				input.assignment ?? current.assignment,
				dependencies,
			);

			const nextRecord: TaskRecord = {
				...current,
				child_session_id: input.child_session_id ?? current.child_session_id,
				root_model: input.root_model ?? current.root_model,
				description: input.description ?? current.description,
				prompt: input.prompt,
				authoritative_context:
					input.authoritative_context ?? current.authoritative_context,
				command:
					typeof input.command === "string" ? input.command : current.command,
				category: input.category ?? current.category,
				routing: input.routing ?? current.routing,
				depends_on: dependencies,
				concurrency_key: input.concurrency_key ?? current.concurrency_key,
				assignment,
				execution: input.execution ?? current.execution,
				run_in_background: input.run_in_background,
				status: nextStatus,
				updated_at: updatedAt,
				started_at: nextStatus === "running" ? updatedAt : undefined,
				completed_at: undefined,
				result: undefined,
				error: undefined,
			};

			store.delegations[input.id] = nextRecord;
			return nextRecord;
		});
	}

	async function updateTask(
		id: string,
		patch: {
			command?: string;
			root_model?: TaskModelSelection;
			assignment?: TaskAssignmentRecord;
			execution?: TaskExecutionRecord;
			result?: string;
			error?: string;
		},
	): Promise<TaskRecord> {
		return withStoreMutation((store) => {
			const current = store.delegations[id];
			if (!current) throw new Error(`Task ${id} not found`);

			const nextRecord: TaskRecord = {
				...current,
				command:
					typeof patch.command === "string" ? patch.command : current.command,
				root_model: patch.root_model ?? current.root_model,
				assignment:
					patch.assignment === undefined
						? current.assignment
						: normalizeTaskAssignmentInput(
								patch.assignment,
								current.depends_on,
							),
				execution: patch.execution ?? current.execution,
				result:
					typeof patch.result === "string" ? patch.result : current.result,
				error: typeof patch.error === "string" ? patch.error : current.error,
				updated_at: nowIso(),
			};

			store.delegations[id] = nextRecord;
			return nextRecord;
		});
	}

	async function getTask(id: string): Promise<TaskRecord | null> {
		const store = await readStore();
		return store.delegations[id] || null;
	}

	async function getTaskByChildSessionID(
		childSessionID: string,
	): Promise<TaskRecord | null> {
		const store = await readStore();
		const record = Object.values(store.delegations)
			.filter((item) => item.child_session_id === childSessionID)
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
		return record || null;
	}

	async function listTasks(filter?: {
		root_session_id?: string;
		status?: TaskStatus;
		limit?: number;
		concurrency_key?: string;
		run_in_background?: boolean;
	}): Promise<TaskRecord[]> {
		const store = await readStore();
		const limit =
			typeof filter?.limit === "number" && Number.isFinite(filter.limit)
				? Math.max(1, Math.floor(filter.limit))
				: Number.POSITIVE_INFINITY;

		return Object.values(store.delegations)
			.filter((record) => {
				if (
					filter?.root_session_id &&
					record.root_session_id !== filter.root_session_id
				) {
					return false;
				}

				if (filter?.status && record.status !== filter.status) {
					return false;
				}

				if (
					filter?.concurrency_key &&
					record.concurrency_key !== filter.concurrency_key
				) {
					return false;
				}

				if (
					typeof filter?.run_in_background === "boolean" &&
					record.run_in_background !== filter.run_in_background
				) {
					return false;
				}

				return true;
			})
			.sort(compareTaskCreationDescending)
			.slice(0, limit);
	}

	async function listRunnableBlockedTasks(filter?: {
		root_session_id?: string;
		limit?: number;
	}): Promise<TaskRecord[]> {
		const store = await readStore();
		const limit =
			typeof filter?.limit === "number" && Number.isFinite(filter.limit)
				? Math.max(1, Math.floor(filter.limit))
				: Number.POSITIVE_INFINITY;

		return Object.values(store.delegations)
			.filter((record) => record.status === "blocked")
			.filter((record) => {
				if (
					filter?.root_session_id &&
					record.root_session_id !== filter.root_session_id
				) {
					return false;
				}

				return collectBlockingDependencies(store, record).length === 0;
			})
			.sort(compareTaskCreationAscending)
			.slice(0, limit);
	}

	async function listRunnableQueuedTasks(
		limit?: number,
	): Promise<TaskRecord[]> {
		const store = await readStore();
		const max =
			typeof limit === "number" && Number.isFinite(limit)
				? Math.max(1, Math.floor(limit))
				: Number.POSITIVE_INFINITY;

		return Object.values(store.delegations)
			.filter((record) => record.status === "queued")
			.sort(compareTaskCreationAscending)
			.slice(0, max);
	}

	async function listPromotableTasks(filter?: {
		root_session_id?: string;
		limit?: number;
	}): Promise<TaskRecord[]> {
		const store = await readStore();
		const limit =
			typeof filter?.limit === "number" && Number.isFinite(filter.limit)
				? Math.max(1, Math.floor(filter.limit))
				: Number.POSITIVE_INFINITY;

		return Object.values(store.delegations)
			.filter((record) => {
				if (
					filter?.root_session_id &&
					record.root_session_id !== filter.root_session_id
				) {
					return false;
				}

				return isPromotableTask(store, record);
			})
			.sort((a, b) => comparePromotableTasks(store, a, b))
			.slice(0, limit);
	}

	async function getBlockingDependencies(id: string): Promise<string[]> {
		const store = await readStore();
		const record = store.delegations[id];
		if (!record) throw new Error(`Task ${id} not found`);

		return collectBlockingDependencies(store, record);
	}

	return {
		readStore,
		createTask,
		transitionTask,
		restartTask,
		updateTask,
		getTask,
		getTaskByChildSessionID,
		listTasks,
		listRunnableBlockedTasks,
		listRunnableQueuedTasks,
		listPromotableTasks,
		getBlockingDependencies,
	};
}

export type TaskStateManager = ReturnType<typeof createTaskStateManager>;
