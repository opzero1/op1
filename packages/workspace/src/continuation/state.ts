import { join } from "../bun-compat.js";
import { isSystemError } from "../utils.js";

export type ContinuationMode = "running" | "stopped" | "handoff";

export interface ContinuationSessionRecord {
	session_id: string;
	mode: ContinuationMode;
	updated_at: string;
	reason?: string;
	handoff_to?: string;
	handoff_summary?: string;
	last_idempotency_key?: string;
	tmux_session_name?: string;
	tmux_window_name?: string;
}

interface ContinuationStore {
	version: 1;
	sessions: Record<string, ContinuationSessionRecord>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function createEmptyStore(): ContinuationStore {
	return {
		version: 1,
		sessions: {},
	};
}

function normalizeRecord(
	sessionID: string,
	value: unknown,
): ContinuationSessionRecord | null {
	if (!value || typeof value !== "object") return null;

	const raw = value as Record<string, unknown>;
	if (
		raw.mode !== "running" &&
		raw.mode !== "stopped" &&
		raw.mode !== "handoff"
	) {
		return null;
	}

	return {
		session_id:
			typeof raw.session_id === "string" && raw.session_id.length > 0
				? raw.session_id
				: sessionID,
		mode: raw.mode,
		updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
		reason: typeof raw.reason === "string" ? raw.reason : undefined,
		handoff_to: typeof raw.handoff_to === "string" ? raw.handoff_to : undefined,
		handoff_summary:
			typeof raw.handoff_summary === "string" ? raw.handoff_summary : undefined,
		last_idempotency_key:
			typeof raw.last_idempotency_key === "string"
				? raw.last_idempotency_key
				: undefined,
		tmux_session_name:
			typeof raw.tmux_session_name === "string"
				? raw.tmux_session_name
				: undefined,
		tmux_window_name:
			typeof raw.tmux_window_name === "string"
				? raw.tmux_window_name
				: undefined,
	};
}

function normalizeStore(value: unknown): ContinuationStore {
	if (!value || typeof value !== "object") return createEmptyStore();

	const raw = value as Record<string, unknown>;
	const sessionsValue = raw.sessions;
	if (!sessionsValue || typeof sessionsValue !== "object") {
		return createEmptyStore();
	}

	const sessions: Record<string, ContinuationSessionRecord> = {};
	for (const [sessionID, entry] of Object.entries(
		sessionsValue as Record<string, unknown>,
	)) {
		const normalized = normalizeRecord(sessionID, entry);
		if (!normalized) continue;
		sessions[sessionID] = normalized;
	}

	return {
		version: 1,
		sessions,
	};
}

export function createContinuationStateManager(workspaceDir: string) {
	const statePath = join(workspaceDir, "continuation.json");
	let mutationQueue: Promise<void> = Promise.resolve();

	async function readStore(): Promise<ContinuationStore> {
		try {
			const file = Bun.file(statePath);
			if (!(await file.exists())) {
				return createEmptyStore();
			}

			const text = await file.text();
			if (!text.trim()) return createEmptyStore();

			const parsed = JSON.parse(text) as unknown;
			return normalizeStore(parsed);
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") {
				return createEmptyStore();
			}
			return createEmptyStore();
		}
	}

	async function writeStore(store: ContinuationStore): Promise<void> {
		const payload = JSON.stringify(store, null, 2);
		const backupPath = `${statePath}.bak`;
		const targetFile = Bun.file(statePath);
		const backupFile = Bun.file(backupPath);

		const hasOriginal = await targetFile.exists();
		if (hasOriginal) {
			await Bun.write(backupPath, targetFile);
		}

		try {
			await Bun.write(statePath, payload);
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

	async function withMutation<T>(
		mutator: (store: ContinuationStore) => Promise<T> | T,
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

	async function getSession(
		sessionID: string,
	): Promise<ContinuationSessionRecord | null> {
		const store = await readStore();
		return store.sessions[sessionID] || null;
	}

	async function setSessionMode(input: {
		session_id: string;
		mode: ContinuationMode;
		reason?: string;
		handoff_to?: string;
		handoff_summary?: string;
		idempotency_key?: string;
		tmux_session_name?: string;
		tmux_window_name?: string;
	}): Promise<ContinuationSessionRecord> {
		return withMutation((store) => {
			const current = store.sessions[input.session_id];
			if (
				input.idempotency_key &&
				current?.last_idempotency_key === input.idempotency_key
			) {
				return current;
			}

			const nextRecord: ContinuationSessionRecord = {
				session_id: input.session_id,
				mode: input.mode,
				updated_at: nowIso(),
				reason: input.reason,
				handoff_to: input.handoff_to,
				handoff_summary: input.handoff_summary,
				last_idempotency_key: input.idempotency_key,
				tmux_session_name:
					typeof input.tmux_session_name === "string"
						? input.tmux_session_name
						: current?.tmux_session_name,
				tmux_window_name:
					typeof input.tmux_window_name === "string"
						? input.tmux_window_name
						: current?.tmux_window_name,
			};

			store.sessions[input.session_id] = nextRecord;
			return nextRecord;
		});
	}

	async function isContinuationAllowed(sessionID: string): Promise<boolean> {
		const current = await getSession(sessionID);
		if (!current) return true;
		return current.mode !== "stopped";
	}

	async function setSessionTmuxMetadata(input: {
		session_id: string;
		tmux_session_name?: string;
		tmux_window_name?: string;
	}): Promise<ContinuationSessionRecord> {
		return withMutation((store) => {
			const current = store.sessions[input.session_id];
			const nextRecord: ContinuationSessionRecord = {
				session_id: input.session_id,
				mode: current?.mode ?? "running",
				updated_at: nowIso(),
				reason: current?.reason,
				handoff_to: current?.handoff_to,
				handoff_summary: current?.handoff_summary,
				last_idempotency_key: current?.last_idempotency_key,
				tmux_session_name: input.tmux_session_name,
				tmux_window_name: input.tmux_window_name,
			};

			store.sessions[input.session_id] = nextRecord;
			return nextRecord;
		});
	}

	return {
		readStore,
		getSession,
		setSessionMode,
		isContinuationAllowed,
		setSessionTmuxMetadata,
	};
}

export type ContinuationStateManager = ReturnType<
	typeof createContinuationStateManager
>;
