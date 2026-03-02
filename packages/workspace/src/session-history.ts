import { relative, resolve } from "./bun-compat.js";
import { redactText, redactUnknown } from "./redaction.js";

type UnknownRecord = Record<string, unknown>;

export interface SessionListArgs {
	limit?: number;
	roots?: boolean;
	start?: number;
	query?: string;
	search?: string;
	directory?: string;
	include_details?: boolean;
}

export interface SessionReadArgs {
	session_id: string;
	include_messages?: boolean;
	message_limit?: number;
	directory?: string;
	include_details?: boolean;
}

export interface SessionSearchArgs {
	query: string;
	limit?: number;
	roots?: boolean;
	start?: number;
	directory?: string;
	case_sensitive?: boolean;
	include_details?: boolean;
}

export interface SessionInfoArgs {
	session_id: string;
	directory?: string;
	include_details?: boolean;
}

export interface SessionToolRuntime {
	client: unknown;
	projectDirectory: string;
}

interface SessionRecord {
	id: string;
	title: string;
	directory?: string;
	parentID?: string;
	time: {
		created?: number;
		updated?: number;
		archived?: number;
	};
	version?: string;
	projectID?: string;
	slug?: string;
	revert?: unknown;
	share?: unknown;
	summary?: unknown;
	permission?: unknown;
}

function asRecord(value: unknown): UnknownRecord | null {
	if (!value || typeof value !== "object") return null;
	return value as UnknownRecord;
}

function getNestedRecord(
	source: unknown,
	path: readonly string[],
): UnknownRecord | null {
	let current = source;
	for (const key of path) {
		const record = asRecord(current);
		if (!record) return null;
		current = record[key];
	}
	return asRecord(current);
}

function getNestedMethod(
	source: unknown,
	path: readonly string[],
): ((input?: unknown) => Promise<unknown>) | null {
	let current = source;
	for (const key of path) {
		const record = asRecord(current);
		if (!record) return null;
		current = record[key];
	}
	if (typeof current !== "function") return null;
	return current as (input?: unknown) => Promise<unknown>;
}

function normalizeResponseData<T>(response: unknown, fallback: T): T {
	const record = asRecord(response);
	if (!record) return fallback;
	if (!("data" in record)) return (response as T) ?? fallback;
	return (record.data as T) ?? fallback;
}

async function invokeWithFallbacks(
	method: ((input?: unknown) => Promise<unknown>) | null,
	inputs: unknown[],
	failureMessage: string,
): Promise<unknown> {
	if (!method) {
		throw new Error(failureMessage);
	}

	let lastError: unknown;
	for (const input of inputs) {
		try {
			return await method(input);
		} catch (error) {
			lastError = error;
		}
	}

	if (lastError instanceof Error) {
		throw new Error(`${failureMessage}: ${lastError.message}`);
	}
	throw new Error(failureMessage);
}

function normalizeSession(value: unknown): SessionRecord | null {
	const record = asRecord(value);
	if (!record) return null;
	if (typeof record.id !== "string") return null;

	const timeRecord = asRecord(record.time) ?? {};
	return {
		id: record.id,
		title: typeof record.title === "string" ? record.title : "(untitled)",
		directory:
			typeof record.directory === "string" ? record.directory : undefined,
		parentID: typeof record.parentID === "string" ? record.parentID : undefined,
		time: {
			created:
				typeof timeRecord.created === "number" ? timeRecord.created : undefined,
			updated:
				typeof timeRecord.updated === "number" ? timeRecord.updated : undefined,
			archived:
				typeof timeRecord.archived === "number"
					? timeRecord.archived
					: undefined,
		},
		version: typeof record.version === "string" ? record.version : undefined,
		projectID:
			typeof record.projectID === "string" ? record.projectID : undefined,
		slug: typeof record.slug === "string" ? record.slug : undefined,
		revert: record.revert,
		share: record.share,
		summary: record.summary,
		permission: record.permission,
	};
}

function normalizeSessionList(value: unknown): SessionRecord[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => normalizeSession(item))
		.filter((item): item is SessionRecord => item !== null);
}

function truncateText(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= 3) return value.slice(0, max);
	return `${value.slice(0, max - 3)}...`;
}

function toISOTime(value?: number): string | undefined {
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
		return undefined;
	}
	return new Date(value).toISOString();
}

function normalizeDirectoryScope(
	projectDirectory: string,
	input?: string,
): { directory: string; explicit: boolean } {
	if (!input) {
		return { directory: projectDirectory, explicit: false };
	}

	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("directory must be a non-empty string when provided");
	}

	const resolved = trimmed.startsWith("/")
		? resolve(trimmed)
		: resolve(projectDirectory, trimmed);
	return { directory: resolved, explicit: true };
}

function normalizeListArgs(args: SessionListArgs): {
	limit: number;
	roots?: boolean;
	start?: number;
	search?: string;
	includeDetails: boolean;
	directory?: string;
} {
	const limit = args.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("limit must be an integer between 1 and 100");
	}

	if (
		args.start !== undefined &&
		(!Number.isFinite(args.start) || args.start < 0)
	) {
		throw new Error("start must be a positive timestamp when provided");
	}

	const search = args.query?.trim() || args.search?.trim() || undefined;
	if (search !== undefined && search.length < 2) {
		throw new Error("query/search must be at least 2 characters");
	}

	return {
		limit,
		roots: args.roots,
		start: args.start,
		search,
		includeDetails: args.include_details ?? false,
		directory: args.directory,
	};
}

function normalizeReadArgs(args: SessionReadArgs): {
	sessionID: string;
	includeMessages: boolean;
	messageLimit: number;
	includeDetails: boolean;
	directory?: string;
} {
	const sessionID = args.session_id.trim();
	if (!sessionID) {
		throw new Error("session_id is required");
	}

	const messageLimit = args.message_limit ?? 8;
	if (
		!Number.isInteger(messageLimit) ||
		messageLimit < 1 ||
		messageLimit > 30
	) {
		throw new Error("message_limit must be an integer between 1 and 30");
	}

	return {
		sessionID,
		includeMessages: args.include_messages ?? false,
		messageLimit,
		includeDetails: args.include_details ?? false,
		directory: args.directory,
	};
}

function normalizeSearchArgs(args: SessionSearchArgs): {
	query: string;
	limit: number;
	roots?: boolean;
	start?: number;
	caseSensitive: boolean;
	includeDetails: boolean;
	directory?: string;
} {
	const query = args.query.trim();
	if (query.length < 2) {
		throw new Error("query must be at least 2 characters");
	}

	const limit = args.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
		throw new Error("limit must be an integer between 1 and 50");
	}

	if (
		args.start !== undefined &&
		(!Number.isFinite(args.start) || args.start < 0)
	) {
		throw new Error("start must be a positive timestamp when provided");
	}

	return {
		query,
		limit,
		roots: args.roots,
		start: args.start,
		caseSensitive: args.case_sensitive ?? false,
		includeDetails: args.include_details ?? false,
		directory: args.directory,
	};
}

function normalizeInfoArgs(args: SessionInfoArgs): {
	sessionID: string;
	includeDetails: boolean;
	directory?: string;
} {
	const sessionID = args.session_id.trim();
	if (!sessionID) {
		throw new Error("session_id is required");
	}

	return {
		sessionID,
		includeDetails: args.include_details ?? true,
		directory: args.directory,
	};
}

async function listSessions(
	client: unknown,
	query: {
		directory?: string;
		roots?: boolean;
		start?: number;
		search?: string;
		limit?: number;
	},
): Promise<SessionRecord[]> {
	const method =
		getNestedMethod(client, ["session", "list"]) ??
		getNestedMethod(client, ["experimental", "session", "list"]);

	const response = await invokeWithFallbacks(
		method,
		[{ query }, query],
		"Session list API is unavailable",
	);

	return normalizeSessionList(normalizeResponseData(response, [] as unknown[]));
}

async function getSession(
	client: unknown,
	sessionID: string,
	directory?: string,
): Promise<SessionRecord | null> {
	const method = getNestedMethod(client, ["session", "get"]);
	const response = await invokeWithFallbacks(
		method,
		[
			{ path: { id: sessionID }, query: directory ? { directory } : undefined },
			{ path: { id: sessionID } },
			{ sessionID, directory },
			{ sessionID },
		],
		"Session get API is unavailable",
	);

	return normalizeSession(normalizeResponseData(response, null));
}

function extractMessageText(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	const text = parts
		.map((part) => asRecord(part))
		.filter((part): part is UnknownRecord => part !== null)
		.map((part) => {
			if (part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
			if (part.type === "step-start" && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter((value) => value.trim().length > 0)
		.join("\n")
		.trim();

	return text;
}

type MessagePreview = {
	id?: string;
	role?: string;
	created?: number;
	text: string;
	partsCount: number;
};

function normalizeMessages(value: unknown): MessagePreview[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item): MessagePreview | null => {
			const record = asRecord(item);
			if (!record) return null;
			const info = asRecord(record.info);
			const time = asRecord(info?.time);
			const parts = Array.isArray(record.parts) ? record.parts : [];

			return {
				id: typeof info?.id === "string" ? info.id : undefined,
				role: typeof info?.role === "string" ? info.role : undefined,
				created: typeof time?.created === "number" ? time.created : undefined,
				text: extractMessageText(parts),
				partsCount: parts.length,
			};
		})
		.filter((item): item is MessagePreview => item !== null);
}

async function getSessionMessages(
	client: unknown,
	sessionID: string,
	limit: number,
	directory?: string,
): Promise<
	Array<{
		id?: string;
		role?: string;
		created?: number;
		text: string;
		partsCount: number;
	}>
> {
	const method = getNestedMethod(client, ["session", "messages"]);
	const response = await invokeWithFallbacks(
		method,
		[
			{
				path: { id: sessionID },
				query: { limit, ...(directory ? { directory } : {}) },
			},
			{ path: { id: sessionID }, query: { limit } },
			{ sessionID, directory, limit },
			{ sessionID, limit },
		],
		"Session messages API is unavailable",
	);

	return normalizeMessages(normalizeResponseData(response, [] as unknown[]));
}

async function getSessionTodos(
	client: unknown,
	sessionID: string,
	directory?: string,
): Promise<unknown[]> {
	const method = getNestedMethod(client, ["session", "todo"]);
	if (!method) return [];
	try {
		const response = await invokeWithFallbacks(
			method,
			[
				{
					path: { id: sessionID },
					query: directory ? { directory } : undefined,
				},
				{ sessionID, directory },
				{ path: { id: sessionID } },
				{ sessionID },
			],
			"Session todo API is unavailable",
		);
		const data = normalizeResponseData(response, [] as unknown[]);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

async function getSessionChildren(
	client: unknown,
	sessionID: string,
	directory?: string,
): Promise<SessionRecord[]> {
	const method = getNestedMethod(client, ["session", "children"]);
	if (!method) return [];
	try {
		const response = await invokeWithFallbacks(
			method,
			[
				{
					path: { id: sessionID },
					query: directory ? { directory } : undefined,
				},
				{ sessionID, directory },
				{ path: { id: sessionID } },
				{ sessionID },
			],
			"Session children API is unavailable",
		);
		return normalizeSessionList(
			normalizeResponseData(response, [] as unknown[]),
		);
	} catch {
		return [];
	}
}

async function getSessionStatusSnapshot(
	client: unknown,
	directory?: string,
): Promise<UnknownRecord | null> {
	const method = getNestedMethod(client, ["session", "status"]);
	if (!method) return null;
	try {
		const response = await invokeWithFallbacks(
			method,
			[
				{ query: directory ? { directory } : undefined },
				{ directory },
				undefined,
			],
			"Session status API is unavailable",
		);
		const data = normalizeResponseData(response, {} as UnknownRecord);
		return asRecord(data);
	} catch {
		return null;
	}
}

function redactAndStringify(value: unknown): string {
	return JSON.stringify(redactUnknown(value), null, 2);
}

function includesQuery(
	text: string,
	query: string,
	caseSensitive: boolean,
): boolean {
	if (caseSensitive) return text.includes(query);
	return text.toLowerCase().includes(query.toLowerCase());
}

export function formatSessionListSummary(input: {
	projectDirectory: string;
	scopeDirectory: string;
	scopeExplicit: boolean;
	limit: number;
	start?: number;
	search?: string;
	sessions: SessionRecord[];
	includeDetails: boolean;
}): string {
	const items = input.sessions.slice(0, input.limit).map((session) => {
		const base = {
			id: session.id,
			title: redactText(truncateText(session.title, 120)),
			updated_at: toISOTime(session.time.updated) ?? null,
			created_at: toISOTime(session.time.created) ?? null,
			parent_id: session.parentID ?? null,
			archived: typeof session.time.archived === "number",
		};

		if (!input.includeDetails) return base;
		return {
			...base,
			directory: session.directory
				? relative(input.projectDirectory, session.directory)
				: null,
			version: session.version ?? null,
		};
	});

	return redactAndStringify({
		tool: "session_list",
		scope: {
			directory: input.scopeDirectory,
			explicit: input.scopeExplicit,
		},
		filters: {
			limit: input.limit,
			start: input.start ?? null,
			search: input.search ?? null,
		},
		count: items.length,
		sessions: items,
	});
}

export async function executeSessionList(
	args: SessionListArgs,
	runtime: SessionToolRuntime,
): Promise<string> {
	const normalized = normalizeListArgs(args);
	const scope = normalizeDirectoryScope(
		runtime.projectDirectory,
		normalized.directory,
	);

	const sessions = await listSessions(runtime.client, {
		directory: scope.directory,
		roots: normalized.roots,
		start: normalized.start,
		search: normalized.search,
		limit: normalized.limit,
	});

	return formatSessionListSummary({
		projectDirectory: runtime.projectDirectory,
		scopeDirectory: scope.directory,
		scopeExplicit: scope.explicit,
		limit: normalized.limit,
		start: normalized.start,
		search: normalized.search,
		sessions,
		includeDetails: normalized.includeDetails,
	});
}

export async function executeSessionRead(
	args: SessionReadArgs,
	runtime: SessionToolRuntime,
): Promise<string> {
	const normalized = normalizeReadArgs(args);
	const scope = normalizeDirectoryScope(
		runtime.projectDirectory,
		normalized.directory,
	);

	const session = await getSession(
		runtime.client,
		normalized.sessionID,
		scope.directory,
	);
	if (!session) {
		return `❌ Session not found in scope: ${normalized.sessionID}`;
	}

	const messages = normalized.includeMessages
		? await getSessionMessages(
				runtime.client,
				normalized.sessionID,
				normalized.messageLimit,
				scope.directory,
			)
		: [];

	const preview = messages
		.filter((item) => item.text.length > 0)
		.slice(-normalized.messageLimit)
		.map((item) => ({
			message_id: item.id ?? null,
			role: item.role ?? null,
			created_at: toISOTime(item.created) ?? null,
			text: redactText(truncateText(item.text, 320)),
			parts_count: item.partsCount,
		}));

	const payload = {
		tool: "session_read",
		scope: {
			directory: scope.directory,
			explicit: scope.explicit,
		},
		session: {
			id: session.id,
			title: redactText(truncateText(session.title, 160)),
			directory: session.directory ?? null,
			parent_id: session.parentID ?? null,
			created_at: toISOTime(session.time.created) ?? null,
			updated_at: toISOTime(session.time.updated) ?? null,
			archived_at: toISOTime(session.time.archived) ?? null,
			version: session.version ?? null,
			project_id: session.projectID ?? null,
			slug: session.slug ?? null,
		},
		preview: normalized.includeMessages
			? {
					included: true,
					limit: normalized.messageLimit,
					count: preview.length,
					messages: preview,
				}
			: {
					included: false,
					limit: normalized.messageLimit,
					count: 0,
					messages: [],
				},
		metadata: normalized.includeDetails
			? {
					revert: session.revert ?? null,
					share: session.share ?? null,
					summary: session.summary ?? null,
					permission: session.permission ?? null,
				}
			: undefined,
	};

	return redactAndStringify(payload);
}

export async function executeSessionSearch(
	args: SessionSearchArgs,
	runtime: SessionToolRuntime,
): Promise<string> {
	const normalized = normalizeSearchArgs(args);
	const scope = normalizeDirectoryScope(
		runtime.projectDirectory,
		normalized.directory,
	);

	const primary = await listSessions(runtime.client, {
		directory: scope.directory,
		roots: normalized.roots,
		start: normalized.start,
		search: normalized.query,
		limit: Math.max(normalized.limit, 20),
	});

	const matches = new Map<
		string,
		{ session: SessionRecord; matchedBy: string }
	>();
	for (const session of primary) {
		matches.set(session.id, {
			session,
			matchedBy: "title-api",
		});
	}

	if (matches.size < normalized.limit) {
		const fallbackPool = await listSessions(runtime.client, {
			directory: scope.directory,
			roots: normalized.roots,
			start: normalized.start,
			limit: 40,
		});

		for (const session of fallbackPool) {
			if (matches.has(session.id)) continue;
			if (
				includesQuery(session.title, normalized.query, normalized.caseSensitive)
			) {
				matches.set(session.id, {
					session,
					matchedBy: "title-local",
				});
			}
			if (matches.size >= normalized.limit) break;
		}

		if (matches.size < normalized.limit) {
			for (const session of fallbackPool.slice(0, 10)) {
				if (matches.has(session.id)) continue;
				const messages = await getSessionMessages(
					runtime.client,
					session.id,
					30,
					scope.directory,
				);
				const hasContentMatch = messages.some((message) =>
					includesQuery(
						message.text,
						normalized.query,
						normalized.caseSensitive,
					),
				);
				if (!hasContentMatch) continue;
				matches.set(session.id, {
					session,
					matchedBy: "content-local",
				});
				if (matches.size >= normalized.limit) break;
			}
		}
	}

	const sessions = Array.from(matches.values())
		.slice(0, normalized.limit)
		.map(({ session, matchedBy }) => {
			const base = {
				id: session.id,
				title: redactText(truncateText(session.title, 120)),
				matched_by: matchedBy,
				updated_at: toISOTime(session.time.updated) ?? null,
			};
			if (!normalized.includeDetails) return base;
			return {
				...base,
				created_at: toISOTime(session.time.created) ?? null,
				parent_id: session.parentID ?? null,
				directory: session.directory ?? null,
			};
		});

	return redactAndStringify({
		tool: "session_search",
		scope: {
			directory: scope.directory,
			explicit: scope.explicit,
		},
		query: normalized.query,
		case_sensitive: normalized.caseSensitive,
		count: sessions.length,
		sessions,
	});
}

export async function executeSessionInfo(
	args: SessionInfoArgs,
	runtime: SessionToolRuntime,
): Promise<string> {
	const normalized = normalizeInfoArgs(args);
	const scope = normalizeDirectoryScope(
		runtime.projectDirectory,
		normalized.directory,
	);

	const session = await getSession(
		runtime.client,
		normalized.sessionID,
		scope.directory,
	);
	if (!session) {
		return `❌ Session not found in scope: ${normalized.sessionID}`;
	}

	const [children, todos, statusSnapshot] = await Promise.all([
		getSessionChildren(runtime.client, normalized.sessionID, scope.directory),
		getSessionTodos(runtime.client, normalized.sessionID, scope.directory),
		getSessionStatusSnapshot(runtime.client, scope.directory),
	]);

	const pendingTodos = todos.filter((item) => {
		const record = asRecord(item);
		return record?.status !== "completed";
	});

	const statusRecord = statusSnapshot
		? getNestedRecord(statusSnapshot, [normalized.sessionID])
		: null;

	const missingRequiredFields = [
		typeof session.id === "string" ? null : "id",
		typeof session.title === "string" ? null : "title",
		typeof session.time.updated === "number" ? null : "time.updated",
	].filter((item): item is string => item !== null);

	const payload = {
		tool: "session_info",
		scope: {
			directory: scope.directory,
			explicit: scope.explicit,
		},
		session: {
			id: session.id,
			title: redactText(truncateText(session.title, 160)),
			parent_id: session.parentID ?? null,
			directory: session.directory ?? null,
			created_at: toISOTime(session.time.created) ?? null,
			updated_at: toISOTime(session.time.updated) ?? null,
			archived_at: toISOTime(session.time.archived) ?? null,
			project_id: session.projectID ?? null,
			version: session.version ?? null,
		},
		integrity: {
			has_parent: Boolean(session.parentID),
			has_children: children.length > 0,
			children_count: children.length,
			todo_count: todos.length,
			pending_todo_count: pendingTodos.length,
			missing_required_fields: missingRequiredFields,
			status_snapshot_available: statusRecord !== null,
		},
		children: children.slice(0, 20).map((child) => ({
			id: child.id,
			title: redactText(truncateText(child.title, 100)),
			updated_at: toISOTime(child.time.updated) ?? null,
		})),
		status_snapshot: normalized.includeDetails ? statusRecord : undefined,
	};

	return redactAndStringify(payload);
}

export function validateSessionArgumentsForTest(input: {
	query?: string;
	limit?: number;
	directory?: string;
}): { query?: string; limit: number; directory?: string } {
	const limit = input.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
		throw new Error("limit must be an integer between 1 and 50");
	}

	const query = input.query?.trim();
	if (query && query.length < 2) {
		throw new Error("query must be at least 2 characters");
	}

	if (input.directory !== undefined && input.directory.trim().length === 0) {
		throw new Error("directory must be a non-empty string when provided");
	}

	return {
		query,
		limit,
		directory: input.directory,
	};
}
