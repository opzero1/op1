import { join } from "../bun-compat.js";
import {
	type JsonRecoveryMethod,
	recordJsonRecoveryFailure,
	recordJsonRecoveryMatch,
} from "../json-recovery-observability.js";
import { createLogger } from "../logging.js";
import { isSystemError } from "../utils.js";
import {
	type DelegationCategory,
	type DelegationRoutingTelemetry,
	parseDelegationCategory,
} from "./router.js";

const logger = createLogger("workspace.delegation-state");

export type DelegationStatus =
	| "queued"
	| "blocked"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface DelegationRecord {
	id: string;
	root_session_id: string;
	parent_session_id: string;
	child_session_id: string;
	agent: string;
	prompt: string;
	category?: DelegationCategory;
	routing?: DelegationRoutingTelemetry;
	tmux_session_name?: string;
	tmux_window_name?: string;
	depends_on?: string[];
	status: DelegationStatus;
	created_at: string;
	updated_at: string;
	started_at?: string;
	completed_at?: string;
	result?: string;
	error?: string;
}

interface DelegationStore {
	version: 2;
	delegations: Record<string, DelegationRecord>;
}

const VALID_TRANSITIONS: Record<DelegationStatus, readonly DelegationStatus[]> =
	{
		queued: ["blocked", "running", "failed", "cancelled"],
		blocked: ["running", "failed", "cancelled"],
		running: ["succeeded", "failed", "cancelled"],
		succeeded: [],
		failed: [],
		cancelled: [],
	};

function nowIso(): string {
	return new Date().toISOString();
}

function createEmptyStore(): DelegationStore {
	return {
		version: 2,
		delegations: {},
	};
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
				// continue
			}
		}

		const objectStart = withoutTrailingCommas.indexOf("{");
		const objectEnd = withoutTrailingCommas.lastIndexOf("}");
		if (objectStart >= 0 && objectEnd > objectStart) {
			try {
				const parsed = JSON.parse(
					withoutTrailingCommas.slice(objectStart, objectEnd + 1),
				);
				logRecoveryMatch(
					"object_boundary_extraction",
					"Recovered malformed JSON by object boundary extraction",
				);
				return parsed;
			} catch {
				// continue
			}
		}

		const arrayStart = withoutTrailingCommas.indexOf("[");
		const arrayEnd = withoutTrailingCommas.lastIndexOf("]");
		if (arrayStart >= 0 && arrayEnd > arrayStart) {
			try {
				const parsed = JSON.parse(
					withoutTrailingCommas.slice(arrayStart, arrayEnd + 1),
				);
				logRecoveryMatch(
					"array_boundary_extraction",
					"Recovered malformed JSON by array boundary extraction",
				);
				return parsed;
			} catch {
				recordJsonRecoveryFailure();
				logger.error("JSON parse recovery failed", {
					source: sourcePath,
					observability_event: "workspace_json_recovery_fail_total",
				});
				return null;
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

function parseDelegationStatus(value: unknown): DelegationStatus | null {
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

function normalizeDelegationRecord(value: unknown): DelegationRecord | null {
	if (!value || typeof value !== "object") return null;

	const raw = value as Record<string, unknown>;
	const status = parseDelegationStatus(raw.status);
	if (!status) return null;

	if (typeof raw.id !== "string") return null;
	if (typeof raw.root_session_id !== "string") return null;
	if (typeof raw.parent_session_id !== "string") return null;
	if (typeof raw.child_session_id !== "string") return null;
	if (typeof raw.agent !== "string") return null;
	if (typeof raw.prompt !== "string") return null;
	const category = parseDelegationCategory(
		typeof raw.category === "string" ? raw.category : undefined,
	);

	return {
		id: raw.id,
		root_session_id: raw.root_session_id,
		parent_session_id: raw.parent_session_id,
		child_session_id: raw.child_session_id,
		agent: raw.agent,
		prompt: raw.prompt,
		category: category ?? undefined,
		routing: normalizeRoutingTelemetry(raw.routing),
		tmux_session_name:
			typeof raw.tmux_session_name === "string"
				? raw.tmux_session_name
				: undefined,
		tmux_window_name:
			typeof raw.tmux_window_name === "string"
				? raw.tmux_window_name
				: undefined,
		depends_on: normalizeDependencyIDs(raw.depends_on),
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

function normalizeStore(value: unknown): DelegationStore {
	if (!value || typeof value !== "object") return createEmptyStore();

	const raw = value as Record<string, unknown>;
	const delegationsRaw = raw.delegations;
	if (!delegationsRaw || typeof delegationsRaw !== "object") {
		return createEmptyStore();
	}

	const delegations: Record<string, DelegationRecord> = {};
	for (const [id, entry] of Object.entries(
		delegationsRaw as Record<string, unknown>,
	)) {
		const record = normalizeDelegationRecord(entry);
		if (!record) continue;
		delegations[id] = record;
	}

	return {
		version: 2,
		delegations,
	};
}

function isTransitionAllowed(
	from: DelegationStatus,
	to: DelegationStatus,
): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].includes(to);
}

function withTransitionGuard(
	record: DelegationRecord,
	nextStatus: DelegationStatus,
): void {
	if (isTransitionAllowed(record.status, nextStatus)) return;

	throw new Error(
		`Invalid delegation transition: ${record.status} -> ${nextStatus} for ${record.id}`,
	);
}

export function createDelegationStateManager(workspaceDir: string) {
	const delegationsPath = join(workspaceDir, "delegations.json");
	let mutationQueue: Promise<void> = Promise.resolve();

	async function readStore(): Promise<DelegationStore> {
		try {
			const file = Bun.file(delegationsPath);
			if (!(await file.exists())) {
				return createEmptyStore();
			}

			const text = await file.text();
			if (!text.trim()) {
				return createEmptyStore();
			}

			const parsed = parseJsonWithRecovery(text, delegationsPath);
			if (!parsed) {
				return createEmptyStore();
			}

			return normalizeStore(parsed);
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") {
				return createEmptyStore();
			}
			throw error;
		}
	}

	async function writeStore(store: DelegationStore): Promise<void> {
		const nextPayload = JSON.stringify(store, null, 2);
		const backupPath = `${delegationsPath}.bak`;
		const targetFile = Bun.file(delegationsPath);
		const backupFile = Bun.file(backupPath);

		const hasOriginal = await targetFile.exists();
		if (hasOriginal) {
			await Bun.write(backupPath, targetFile);
		}

		try {
			await Bun.write(delegationsPath, nextPayload);
			if (await backupFile.exists()) {
				await backupFile.delete();
			}
		} catch (error) {
			if (hasOriginal && (await backupFile.exists())) {
				await Bun.write(delegationsPath, backupFile);
				await backupFile.delete();
			}
			throw error;
		}
	}

	async function withStoreMutation<T>(
		mutator: (store: DelegationStore) => Promise<T> | T,
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

	function hasDependencyPath(
		store: DelegationStore,
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
		store: DelegationStore,
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
		store: DelegationStore,
		record: Pick<DelegationRecord, "depends_on">,
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

	async function createDelegation(input: {
		id: string;
		root_session_id: string;
		parent_session_id: string;
		child_session_id: string;
		agent: string;
		prompt: string;
		category?: DelegationCategory;
		routing?: DelegationRoutingTelemetry;
		tmux_session_name?: string;
		tmux_window_name?: string;
		depends_on?: string[];
		initial_status?: "queued" | "blocked";
	}): Promise<DelegationRecord> {
		return withStoreMutation((store) => {
			if (store.delegations[input.id]) {
				throw new Error(`Delegation ${input.id} already exists`);
			}

			const dependencies = input.depends_on
				? [...new Set(input.depends_on.map((entry) => entry.trim()))].filter(
						(entry) => entry.length > 0,
					)
				: [];

			for (const dependencyID of dependencies) {
				const dependency = store.delegations[dependencyID];
				if (!dependency) {
					throw new Error(
						`Delegation dependency '${dependencyID}' was not found.`,
					);
				}

				if (dependency.root_session_id !== input.root_session_id) {
					throw new Error(
						`Delegation dependency '${dependencyID}' is outside the root session scope.`,
					);
				}
			}

			if (hasDependencyCycle(store, input.id, dependencies)) {
				throw new Error(
					`Dependency cycle detected while creating delegation '${input.id}'.`,
				);
			}

			const blockers = collectBlockingDependencies(store, {
				depends_on: dependencies,
			});

			const initialStatus =
				input.initial_status ?? (blockers.length > 0 ? "blocked" : "queued");

			const createdAt = nowIso();
			const record: DelegationRecord = {
				id: input.id,
				root_session_id: input.root_session_id,
				parent_session_id: input.parent_session_id,
				child_session_id: input.child_session_id,
				agent: input.agent,
				prompt: input.prompt,
				category: input.category,
				routing: input.routing,
				tmux_session_name: input.tmux_session_name,
				tmux_window_name: input.tmux_window_name,
				depends_on: dependencies.length > 0 ? dependencies : undefined,
				status: initialStatus,
				created_at: createdAt,
				updated_at: createdAt,
			};

			store.delegations[input.id] = record;
			return record;
		});
	}

	async function transitionDelegation(
		id: string,
		nextStatus: DelegationStatus,
		patch?: { result?: string; error?: string },
	): Promise<DelegationRecord> {
		return withStoreMutation((store) => {
			const current = store.delegations[id];
			if (!current) {
				throw new Error(`Delegation ${id} not found`);
			}

			if (current.status === nextStatus) {
				return current;
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

			const nextRecord: DelegationRecord = {
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

	async function getDelegation(id: string): Promise<DelegationRecord | null> {
		const store = await readStore();
		return store.delegations[id] || null;
	}

	async function getDelegationByChildSessionID(
		childSessionID: string,
	): Promise<DelegationRecord | null> {
		const store = await readStore();
		const record = Object.values(store.delegations).find(
			(item) => item.child_session_id === childSessionID,
		);
		return record || null;
	}

	async function listDelegations(filter?: {
		root_session_id?: string;
		status?: DelegationStatus;
		limit?: number;
	}): Promise<DelegationRecord[]> {
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

				return true;
			})
			.sort((a, b) => b.created_at.localeCompare(a.created_at))
			.slice(0, limit);
	}

	async function listRunnableBlockedDelegations(filter?: {
		root_session_id?: string;
		limit?: number;
	}): Promise<DelegationRecord[]> {
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

	async function getBlockingDependencies(id: string): Promise<string[]> {
		const store = await readStore();
		const record = store.delegations[id];
		if (!record) {
			throw new Error(`Delegation ${id} not found`);
		}

		return collectBlockingDependencies(store, record);
	}

	return {
		readStore,
		createDelegation,
		transitionDelegation,
		getDelegation,
		getDelegationByChildSessionID,
		listDelegations,
		listRunnableBlockedDelegations,
		getBlockingDependencies,
	};
}

export type DelegationStateManager = ReturnType<
	typeof createDelegationStateManager
>;
