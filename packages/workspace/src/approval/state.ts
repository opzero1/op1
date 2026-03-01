import { join } from "../bun-compat.js";
import {
	type JsonRecoveryMethod,
	recordJsonRecoveryFailure,
	recordJsonRecoveryMatch,
} from "../json-recovery-observability.js";
import { createLogger } from "../logging.js";
import { isSystemError } from "../utils.js";
import { normalizeApprovalToolName } from "./policy.js";

const logger = createLogger("workspace.approval-state");

export type ApprovalAuditOutcome =
	| "approved"
	| "denied"
	| "blocked"
	// Legacy-only value retained for backward-compatible reads.
	| "bypassed";

export type ApprovalAuditReason =
	| "cached_grant"
	| "prompt_approved"
	| "prompt_denied"
	| "prompt_unavailable"
	| "non_interactive_blocked"
	// Legacy-only value retained for backward-compatible reads.
	| "non_interactive_bypass"
	| "policy_idempotency_required"
	| "policy_transition_applied";

export interface ApprovalGrant {
	tool: string;
	grant_id: string;
	approved_at: string;
	expires_at: string;
}

export interface ApprovalAuditRecord {
	id: string;
	session_id: string;
	tool: string;
	outcome: ApprovalAuditOutcome;
	reason: ApprovalAuditReason;
	created_at: string;
	expires_at?: string;
	detail?: string;
	metadata?: Record<string, string | number | boolean>;
}

interface SessionApprovalState {
	updated_at: string;
	grants: Record<string, ApprovalGrant>;
	replayed_request_ids: Record<string, string>;
}

interface ApprovalStore {
	version: 1;
	sessions: Record<string, SessionApprovalState>;
	audit: ApprovalAuditRecord[];
}

const AUDIT_LIMIT = 1000;
const REQUEST_REPLAY_TTL_MS = 15 * 60_000;

function nowIso(): string {
	return new Date().toISOString();
}

function createStore(): ApprovalStore {
	return {
		version: 1,
		sessions: {},
		audit: [],
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

		recordJsonRecoveryFailure();
		logger.error("JSON parse recovery failed", {
			source: sourcePath,
			observability_event: "workspace_json_recovery_fail_total",
		});
		return null;
	}
}

function normalizeAuditRecord(value: unknown): ApprovalAuditRecord | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;

	if (typeof raw.id !== "string") return null;
	if (typeof raw.session_id !== "string") return null;
	if (typeof raw.tool !== "string") return null;
	if (
		raw.outcome !== "approved" &&
		raw.outcome !== "denied" &&
		raw.outcome !== "blocked" &&
		raw.outcome !== "bypassed"
	) {
		return null;
	}

	const reason = raw.reason;
	if (
		reason !== "cached_grant" &&
		reason !== "prompt_approved" &&
		reason !== "prompt_denied" &&
		reason !== "prompt_unavailable" &&
		reason !== "non_interactive_blocked" &&
		reason !== "non_interactive_bypass" &&
		reason !== "policy_idempotency_required" &&
		reason !== "policy_transition_applied"
	) {
		return null;
	}

	const metadata: Record<string, string | number | boolean> = {};
	if (raw.metadata && typeof raw.metadata === "object") {
		for (const [key, metaValue] of Object.entries(
			raw.metadata as Record<string, unknown>,
		)) {
			if (
				typeof metaValue === "string" ||
				typeof metaValue === "number" ||
				typeof metaValue === "boolean"
			) {
				metadata[key] = metaValue;
			}
		}
	}

	return {
		id: raw.id,
		session_id: raw.session_id,
		tool: normalizeApprovalToolName(raw.tool),
		outcome: raw.outcome,
		reason,
		created_at: typeof raw.created_at === "string" ? raw.created_at : nowIso(),
		expires_at: typeof raw.expires_at === "string" ? raw.expires_at : undefined,
		detail: typeof raw.detail === "string" ? raw.detail : undefined,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
}

function normalizeGrant(value: unknown): ApprovalGrant | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;

	if (typeof raw.tool !== "string") return null;
	if (typeof raw.grant_id !== "string" || raw.grant_id.length === 0)
		return null;
	if (typeof raw.approved_at !== "string") return null;
	if (typeof raw.expires_at !== "string") return null;

	return {
		tool: normalizeApprovalToolName(raw.tool),
		grant_id: raw.grant_id,
		approved_at: raw.approved_at,
		expires_at: raw.expires_at,
	};
}

function normalizeSession(value: unknown): SessionApprovalState | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;

	const grants: Record<string, ApprovalGrant> = {};
	if (raw.grants && typeof raw.grants === "object") {
		for (const [tool, entry] of Object.entries(
			raw.grants as Record<string, unknown>,
		)) {
			const normalizedTool = normalizeApprovalToolName(tool);
			if (!normalizedTool) continue;
			const grant = normalizeGrant(entry);
			if (!grant) continue;
			grants[normalizedTool] = grant;
		}
	}

	const replayedRequestIDs: Record<string, string> = {};
	if (
		raw.replayed_request_ids &&
		typeof raw.replayed_request_ids === "object"
	) {
		for (const [requestID, replayedAt] of Object.entries(
			raw.replayed_request_ids as Record<string, unknown>,
		)) {
			if (typeof replayedAt !== "string") continue;
			replayedRequestIDs[requestID] = replayedAt;
		}
	}

	return {
		updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
		grants,
		replayed_request_ids: replayedRequestIDs,
	};
}

function normalizeStore(value: unknown): ApprovalStore {
	if (!value || typeof value !== "object") return createStore();
	const raw = value as Record<string, unknown>;

	const sessions: Record<string, SessionApprovalState> = {};
	if (raw.sessions && typeof raw.sessions === "object") {
		for (const [sessionID, entry] of Object.entries(
			raw.sessions as Record<string, unknown>,
		)) {
			const session = normalizeSession(entry);
			if (!session) continue;
			sessions[sessionID] = session;
		}
	}

	const audit = Array.isArray(raw.audit)
		? raw.audit
				.map((entry) => normalizeAuditRecord(entry))
				.filter((entry): entry is ApprovalAuditRecord => !!entry)
		: [];

	return {
		version: 1,
		sessions,
		audit: audit.slice(-AUDIT_LIMIT),
	};
}

function ensureSession(
	store: ApprovalStore,
	sessionID: string,
): SessionApprovalState {
	const existing = store.sessions[sessionID];
	if (existing) return existing;

	const created: SessionApprovalState = {
		updated_at: nowIso(),
		grants: {},
		replayed_request_ids: {},
	};
	store.sessions[sessionID] = created;
	return created;
}

function pruneExpiredSessionData(
	session: SessionApprovalState,
	nowMs: number,
): void {
	for (const [tool, grant] of Object.entries(session.grants)) {
		const expiresAtMs = Date.parse(grant.expires_at);
		if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
			delete session.grants[tool];
		}
	}

	for (const [requestID, replayedAt] of Object.entries(
		session.replayed_request_ids,
	)) {
		const replayedMs = Date.parse(replayedAt);
		if (
			!Number.isFinite(replayedMs) ||
			replayedMs + REQUEST_REPLAY_TTL_MS <= nowMs
		) {
			delete session.replayed_request_ids[requestID];
		}
	}
}

export function createApprovalStateManager(workspaceDir: string) {
	const statePath = join(workspaceDir, "approval-gate.json");
	let mutationQueue: Promise<void> = Promise.resolve();

	async function readStore(): Promise<ApprovalStore> {
		try {
			const file = Bun.file(statePath);
			if (!(await file.exists())) {
				return createStore();
			}

			const text = await file.text();
			if (!text.trim()) {
				return createStore();
			}

			const parsed = parseJsonWithRecovery(text, statePath);
			if (!parsed) {
				return createStore();
			}

			return normalizeStore(parsed);
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") {
				return createStore();
			}
			throw error;
		}
	}

	async function writeStore(store: ApprovalStore): Promise<void> {
		const nextPayload = JSON.stringify(store, null, 2);
		const backupPath = `${statePath}.bak`;
		const targetFile = Bun.file(statePath);
		const backupFile = Bun.file(backupPath);

		const hasOriginal = await targetFile.exists();
		if (hasOriginal) {
			await Bun.write(backupPath, targetFile);
		}

		try {
			await Bun.write(statePath, nextPayload);
			if (await backupFile.exists()) {
				await backupFile.delete();
			}
		} catch (error) {
			if (hasOriginal && (await backupFile.exists())) {
				await Bun.write(statePath, backupFile);
				await backupFile.delete();
			}
			throw error;
		}
	}

	async function withStoreMutation<T>(
		mutator: (store: ApprovalStore) => Promise<T> | T,
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

	async function getActiveGrant(
		sessionID: string,
		tool: string,
	): Promise<ApprovalGrant | null> {
		const normalizedTool = normalizeApprovalToolName(tool);
		if (!normalizedTool) return null;

		return withStoreMutation((store) => {
			const session = ensureSession(store, sessionID);
			const nowMs = Date.now();
			pruneExpiredSessionData(session, nowMs);
			session.updated_at = nowIso();

			return session.grants[normalizedTool] ?? null;
		});
	}

	async function approveTool(input: {
		sessionID: string;
		tool: string;
		ttlMs: number;
		requestID?: string;
	}): Promise<ApprovalGrant | null> {
		const normalizedTool = normalizeApprovalToolName(input.tool);
		if (!normalizedTool) return null;

		const ttlMs = Math.max(0, Math.floor(input.ttlMs));
		if (ttlMs === 0) return null;

		return withStoreMutation((store) => {
			const session = ensureSession(store, input.sessionID);
			const nowMs = Date.now();
			pruneExpiredSessionData(session, nowMs);

			if (input.requestID && session.replayed_request_ids[input.requestID]) {
				return session.grants[normalizedTool] ?? null;
			}

			const approvedAt = nowIso();
			const expiresAt = new Date(nowMs + ttlMs).toISOString();
			const nextGrant: ApprovalGrant = {
				tool: normalizedTool,
				grant_id: crypto.randomUUID(),
				approved_at: approvedAt,
				expires_at: expiresAt,
			};

			session.grants[normalizedTool] = nextGrant;
			session.updated_at = approvedAt;

			if (input.requestID) {
				session.replayed_request_ids[input.requestID] = approvedAt;
			}

			return nextGrant;
		});
	}

	async function recordAudit(
		event: Omit<ApprovalAuditRecord, "id" | "created_at" | "tool"> & {
			tool: string;
		},
	): Promise<ApprovalAuditRecord | null> {
		const normalizedTool = normalizeApprovalToolName(event.tool);
		if (!normalizedTool) return null;

		return withStoreMutation((store) => {
			const createdAt = nowIso();
			const record: ApprovalAuditRecord = {
				id: crypto.randomUUID(),
				created_at: createdAt,
				session_id: event.session_id,
				tool: normalizedTool,
				outcome: event.outcome,
				reason: event.reason,
				expires_at: event.expires_at,
				detail: event.detail,
				metadata: event.metadata,
			};

			store.audit.push(record);
			if (store.audit.length > AUDIT_LIMIT) {
				store.audit = store.audit.slice(-AUDIT_LIMIT);
			}

			return record;
		});
	}

	return {
		readStore,
		getActiveGrant,
		approveTool,
		recordAudit,
	};
}

export type ApprovalStateManager = ReturnType<
	typeof createApprovalStateManager
>;
