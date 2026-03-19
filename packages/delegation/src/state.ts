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

export interface TaskRecord {
	id: string;
	root_session_id: string;
	parent_session_id: string;
	child_session_id: string;
	description: string;
	agent: string;
	prompt: string;
	command?: string;
	category?: DelegationCategory;
	routing?: DelegationRoutingTelemetry;
	depends_on?: string[];
	concurrency_key?: string;
	run_in_background: boolean;
	status: TaskStatus;
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
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

function nowIso(): string {
	return new Date().toISOString();
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

function parseRoutingFallbackPath(
	value: unknown,
): DelegationRoutingTelemetry["fallback_path"] | null {
	if (value === "none") return "none";
	if (value === "category-default") return "category-default";
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
		description: raw.description,
		agent: raw.agent,
		prompt: raw.prompt,
		command: typeof raw.command === "string" ? raw.command : undefined,
		category: category ?? undefined,
		routing: normalizeRoutingTelemetry(raw.routing),
		depends_on: normalizeDependencyIDs(raw.depends_on),
		concurrency_key:
			typeof raw.concurrency_key === "string" ? raw.concurrency_key : undefined,
		run_in_background: raw.run_in_background,
		status,
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
		description: string;
		agent: string;
		prompt: string;
		command?: string;
		category?: DelegationCategory;
		routing?: DelegationRoutingTelemetry;
		depends_on?: string[];
		concurrency_key?: string;
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
			const startedAt = initialStatus === "running" ? createdAt : undefined;
			const record: TaskRecord = {
				id: input.id,
				root_session_id: input.root_session_id,
				parent_session_id: input.parent_session_id,
				child_session_id: input.child_session_id,
				description: input.description,
				agent: input.agent,
				prompt: input.prompt,
				command: input.command,
				category: input.category,
				routing: input.routing,
				depends_on: dependencies.length > 0 ? dependencies : undefined,
				concurrency_key: input.concurrency_key,
				run_in_background: input.run_in_background,
				status: initialStatus,
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
		description?: string;
		prompt: string;
		command?: string;
		category?: DelegationCategory;
		routing?: DelegationRoutingTelemetry;
		depends_on?: string[];
		concurrency_key?: string;
		run_in_background: boolean;
		initial_status?: "queued" | "blocked" | "running";
	}): Promise<TaskRecord> {
		return withStoreMutation((store) => {
			const current = store.delegations[input.id];
			if (!current) throw new Error(`Task ${input.id} not found`);
			if (
				current.status === "queued" ||
				current.status === "blocked" ||
				current.status === "running"
			) {
				throw new Error(`Task ${input.id} is already active.`);
			}

			const dependencies = input.depends_on ?? current.depends_on;
			const blockers = collectBlockingDependencies(store, {
				depends_on: dependencies,
			});
			const nextStatus =
				input.initial_status ?? (blockers.length > 0 ? "blocked" : "queued");
			const updatedAt = nowIso();

			const nextRecord: TaskRecord = {
				...current,
				child_session_id: input.child_session_id ?? current.child_session_id,
				description: input.description ?? current.description,
				prompt: input.prompt,
				command:
					typeof input.command === "string" ? input.command : current.command,
				category: input.category ?? current.category,
				routing: input.routing ?? current.routing,
				depends_on: dependencies,
				concurrency_key: input.concurrency_key ?? current.concurrency_key,
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
			.sort((a, b) => b.created_at.localeCompare(a.created_at))
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
			.sort((a, b) => a.created_at.localeCompare(b.created_at))
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
			.sort((a, b) => a.created_at.localeCompare(b.created_at))
			.slice(0, max);
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
		getTask,
		getTaskByChildSessionID,
		listTasks,
		listRunnableBlockedTasks,
		listRunnableQueuedTasks,
		getBlockingDependencies,
	};
}

export type TaskStateManager = ReturnType<typeof createTaskStateManager>;
