import { join, mkdir } from "../bun-compat.js";
import {
	type JsonRecoveryMethod,
	recordJsonRecoveryFailure,
	recordJsonRecoveryMatch,
} from "../json-recovery-observability.js";
import { createLogger } from "../logging.js";
import { isSystemError } from "../utils.js";

const logger = createLogger("workspace.context-scout-state");

export type PatternSeverity = "critical" | "high" | "medium";

const DEFAULT_TTL_BY_SEVERITY_MS: Record<PatternSeverity, number> = {
	critical: 72 * 60 * 60 * 1000,
	high: 48 * 60 * 60 * 1000,
	medium: 24 * 60 * 60 * 1000,
};

const RANKING_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
const RANKING_SEVERITY_WEIGHT = 0.5;
const RANKING_CONFIDENCE_WEIGHT = 0.35;
const RANKING_RECENCY_WEIGHT = 0.15;

export interface PatternRecord {
	id: string;
	pattern: string;
	severity: PatternSeverity;
	source_tool?: string;
	file_path?: string;
	symbol?: string;
	confidence: number;
	tags: string[];
	first_seen_at: string;
	last_seen_at: string;
	expires_at: string;
}

interface PatternStore {
	version: 1;
	updated_at: string;
	patterns: Record<string, PatternRecord>;
}

export interface UpsertPatternInput {
	pattern: string;
	severity?: PatternSeverity;
	source_tool?: string;
	file_path?: string;
	symbol?: string;
	confidence?: number;
	tags?: string[];
	id?: string;
	ttl_ms?: number;
}

export interface UpsertPatternSummary {
	added: number;
	updated: number;
	total: number;
}

export interface RankedPatternRecord extends PatternRecord {
	score: number;
}

const SEVERITY_ORDER: Record<PatternSeverity, number> = {
	critical: 3,
	high: 2,
	medium: 1,
};

function nowIso(nowMs = Date.now()): string {
	return new Date(nowMs).toISOString();
}

function createEmptyStore(nowMs = Date.now()): PatternStore {
	return {
		version: 1,
		updated_at: nowIso(nowMs),
		patterns: {},
	};
}

function boundedConfidence(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
	return Math.min(1, Math.max(0, value));
}

function parseSeverity(value: unknown): PatternSeverity {
	if (value === "critical") return "critical";
	if (value === "high") return "high";
	return "medium";
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.filter((item): item is string => typeof item === "string"),
		),
	];
}

function hashPatternIdentity(input: {
	pattern: string;
	file_path?: string;
	symbol?: string;
	source_tool?: string;
}): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(
		JSON.stringify({
			pattern: input.pattern,
			file_path: input.file_path ?? "",
			symbol: input.symbol ?? "",
			source_tool: input.source_tool ?? "",
		}),
	);
	return hasher.digest("hex").slice(0, 16);
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
				// continue recovery
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
				// continue recovery
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

function normalizePatternRecord(value: unknown): PatternRecord | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || typeof raw.pattern !== "string")
		return null;

	return {
		id: raw.id,
		pattern: raw.pattern,
		severity: parseSeverity(raw.severity),
		source_tool:
			typeof raw.source_tool === "string" ? raw.source_tool : undefined,
		file_path: typeof raw.file_path === "string" ? raw.file_path : undefined,
		symbol: typeof raw.symbol === "string" ? raw.symbol : undefined,
		confidence: boundedConfidence(raw.confidence),
		tags: normalizeTags(raw.tags),
		first_seen_at:
			typeof raw.first_seen_at === "string" ? raw.first_seen_at : nowIso(),
		last_seen_at:
			typeof raw.last_seen_at === "string" ? raw.last_seen_at : nowIso(),
		expires_at: typeof raw.expires_at === "string" ? raw.expires_at : nowIso(),
	};
}

function normalizeStore(value: unknown): PatternStore {
	if (!value || typeof value !== "object") return createEmptyStore();
	const raw = value as Record<string, unknown>;
	const patternsRaw = raw.patterns;
	if (!patternsRaw || typeof patternsRaw !== "object") {
		return createEmptyStore();
	}

	const patterns: Record<string, PatternRecord> = {};
	for (const [id, entry] of Object.entries(
		patternsRaw as Record<string, unknown>,
	)) {
		const record = normalizePatternRecord(entry);
		if (!record) continue;
		patterns[id] = record;
	}

	return {
		version: 1,
		updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
		patterns,
	};
}

function severityRank(severity: PatternSeverity): number {
	return SEVERITY_ORDER[severity];
}

function normalizeIdentityValue(value: string | undefined): string {
	if (!value) return "";
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function toDedupeIdentity(record: PatternRecord): string {
	return JSON.stringify({
		pattern: normalizeIdentityValue(record.pattern),
		file_path: normalizeIdentityValue(record.file_path),
		symbol: normalizeIdentityValue(record.symbol),
	});
}

function parseTimestampMs(value: string, fallbackMs: number): number {
	const parsed = new Date(value).getTime();
	if (!Number.isFinite(parsed)) return fallbackMs;
	return parsed;
}

function maxIso(a: string, b: string, nowMs = Date.now()): string {
	return parseTimestampMs(a, nowMs) >= parseTimestampMs(b, nowMs) ? a : b;
}

function minIso(a: string, b: string, nowMs = Date.now()): string {
	return parseTimestampMs(a, nowMs) <= parseTimestampMs(b, nowMs) ? a : b;
}

function mergePatternRecords(
	a: PatternRecord,
	b: PatternRecord,
): PatternRecord {
	const keepB = b.confidence > a.confidence;

	return {
		id: a.id,
		pattern: keepB ? b.pattern : a.pattern,
		severity:
			severityRank(a.severity) >= severityRank(b.severity)
				? a.severity
				: b.severity,
		source_tool: keepB
			? (b.source_tool ?? a.source_tool)
			: (a.source_tool ?? b.source_tool),
		file_path: a.file_path ?? b.file_path,
		symbol: a.symbol ?? b.symbol,
		confidence: Math.max(a.confidence, b.confidence),
		tags: [...new Set([...a.tags, ...b.tags])],
		first_seen_at: minIso(a.first_seen_at, b.first_seen_at),
		last_seen_at: maxIso(a.last_seen_at, b.last_seen_at),
		expires_at: maxIso(a.expires_at, b.expires_at),
	};
}

function dedupePatternRecords(records: PatternRecord[]): PatternRecord[] {
	const deduped = new Map<string, PatternRecord>();

	for (const record of records) {
		const identity = toDedupeIdentity(record);
		const existing = deduped.get(identity);
		if (!existing) {
			deduped.set(identity, record);
			continue;
		}

		deduped.set(identity, mergePatternRecords(existing, record));
	}

	return [...deduped.values()];
}

function recencyScore(lastSeenAt: string, nowMs: number): number {
	const ageMs = Math.max(0, nowMs - parseTimestampMs(lastSeenAt, nowMs));
	return 2 ** (-ageMs / RANKING_HALF_LIFE_MS);
}

function computePatternScore(record: PatternRecord, nowMs: number): number {
	const severityScore = severityRank(record.severity) / 3;
	const confidenceScore = boundedConfidence(record.confidence);
	const freshness = recencyScore(record.last_seen_at, nowMs);
	return (
		severityScore * RANKING_SEVERITY_WEIGHT +
		confidenceScore * RANKING_CONFIDENCE_WEIGHT +
		freshness * RANKING_RECENCY_WEIGHT
	);
}

export function createContextScoutStateManager(workspaceDir: string) {
	const contextScoutDir = join(workspaceDir, "context-scout");
	const storePath = join(contextScoutDir, "pattern-index.json");
	let mutationQueue: Promise<void> = Promise.resolve();

	async function readStore(): Promise<PatternStore> {
		try {
			const file = Bun.file(storePath);
			if (!(await file.exists())) return createEmptyStore();

			const text = await file.text();
			if (!text.trim()) return createEmptyStore();

			const parsed = parseJsonWithRecovery(text, storePath);
			if (!parsed) return createEmptyStore();

			return normalizeStore(parsed);
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") {
				return createEmptyStore();
			}
			throw error;
		}
	}

	async function writeStore(store: PatternStore): Promise<void> {
		await mkdir(contextScoutDir, { recursive: true });

		const nextPayload = JSON.stringify(store, null, 2);
		const backupPath = `${storePath}.bak`;
		const targetFile = Bun.file(storePath);
		const backupFile = Bun.file(backupPath);
		const hasOriginal = await targetFile.exists();

		if (hasOriginal) {
			await Bun.write(backupPath, targetFile);
		}

		try {
			await Bun.write(storePath, nextPayload);
			if (await backupFile.exists()) {
				await backupFile.delete();
			}
		} catch (error) {
			if (hasOriginal && (await backupFile.exists())) {
				await Bun.write(storePath, backupFile);
				await backupFile.delete();
			}
			throw error;
		}
	}

	async function withStoreMutation<T>(
		mutator: (store: PatternStore) => Promise<T> | T,
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

	async function upsertPatterns(
		patterns: UpsertPatternInput[],
		nowMs = Date.now(),
	): Promise<UpsertPatternSummary> {
		return withStoreMutation((store) => {
			let added = 0;
			let updated = 0;

			for (const input of patterns) {
				const pattern = input.pattern?.trim();
				if (!pattern) continue;

				const id =
					typeof input.id === "string" && input.id.trim().length > 0
						? input.id.trim()
						: hashPatternIdentity({
								pattern,
								file_path: input.file_path,
								symbol: input.symbol,
								source_tool: input.source_tool,
							});

				const current = store.patterns[id];
				const seenAt = nowIso(nowMs);
				const nextSeverity =
					input.severity !== undefined
						? parseSeverity(input.severity)
						: (current?.severity ?? "medium");
				const defaultTtlMs = DEFAULT_TTL_BY_SEVERITY_MS[nextSeverity];
				const ttlMs =
					typeof input.ttl_ms === "number" && Number.isFinite(input.ttl_ms)
						? Math.max(1_000, Math.floor(input.ttl_ms))
						: defaultTtlMs;

				const nextRecord: PatternRecord = {
					id,
					pattern,
					severity: nextSeverity,
					source_tool:
						typeof input.source_tool === "string"
							? input.source_tool
							: current?.source_tool,
					file_path:
						typeof input.file_path === "string"
							? input.file_path
							: current?.file_path,
					symbol:
						typeof input.symbol === "string" ? input.symbol : current?.symbol,
					confidence: boundedConfidence(
						input.confidence ?? current?.confidence,
					),
					tags: normalizeTags(input.tags ?? current?.tags),
					first_seen_at: current?.first_seen_at ?? seenAt,
					last_seen_at: seenAt,
					expires_at: nowIso(nowMs + ttlMs),
				};

				if (current) {
					updated += 1;
				} else {
					added += 1;
				}

				store.patterns[id] = nextRecord;
			}

			store.updated_at = nowIso(nowMs);

			return {
				added,
				updated,
				total: Object.keys(store.patterns).length,
			};
		});
	}

	async function listPatterns(options?: {
		severity_at_least?: PatternSeverity;
		include_expired?: boolean;
		nowMs?: number;
		limit?: number;
	}): Promise<PatternRecord[]> {
		const store = await readStore();
		const nowMs = options?.nowMs ?? Date.now();
		const minSeverity = options?.severity_at_least;
		const includeExpired = options?.include_expired ?? false;
		const limit =
			typeof options?.limit === "number" && Number.isFinite(options.limit)
				? Math.max(1, Math.floor(options.limit))
				: Number.POSITIVE_INFINITY;

		return Object.values(store.patterns)
			.filter((record) => {
				if (!includeExpired && new Date(record.expires_at).getTime() <= nowMs) {
					return false;
				}
				if (!minSeverity) return true;
				return severityRank(record.severity) >= severityRank(minSeverity);
			})
			.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
			.slice(0, limit);
	}

	async function listRankedPatterns(options?: {
		severity_at_least?: PatternSeverity;
		nowMs?: number;
		limit?: number;
		dedupe?: boolean;
	}): Promise<RankedPatternRecord[]> {
		const nowMs = options?.nowMs ?? Date.now();
		const limit =
			typeof options?.limit === "number" && Number.isFinite(options.limit)
				? Math.max(1, Math.floor(options.limit))
				: Number.POSITIVE_INFINITY;
		const records = await listPatterns({
			severity_at_least: options?.severity_at_least,
			nowMs,
			include_expired: false,
		});

		const candidates =
			options?.dedupe === false ? records : dedupePatternRecords(records);

		return candidates
			.map((record) => ({
				...record,
				score: computePatternScore(record, nowMs),
			}))
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				const severityDiff =
					severityRank(b.severity) - severityRank(a.severity);
				if (severityDiff !== 0) return severityDiff;
				return b.last_seen_at.localeCompare(a.last_seen_at);
			})
			.slice(0, limit);
	}

	async function pruneExpired(nowMs = Date.now()): Promise<number> {
		return withStoreMutation((store) => {
			let removed = 0;
			for (const [id, record] of Object.entries(store.patterns)) {
				if (new Date(record.expires_at).getTime() > nowMs) continue;
				delete store.patterns[id];
				removed += 1;
			}

			if (removed > 0) {
				store.updated_at = nowIso(nowMs);
			}

			return removed;
		});
	}

	return {
		storePath,
		readStore,
		upsertPatterns,
		listPatterns,
		listRankedPatterns,
		pruneExpired,
	};
}

export type ContextScoutStateManager = ReturnType<
	typeof createContextScoutStateManager
>;
