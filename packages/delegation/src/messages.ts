import type { FullSessionFormatOptions, SessionMessage } from "./types.js";

export interface SessionActivitySummary {
	read_count: number;
	search_count: number;
	planning_count: number;
	edit_count: number;
	other_count: number;
}

const READ_TOOLS = new Set([
	"read",
	"session_read",
	"session_info",
	"plan_read",
	"plan_context_read",
	"plan_doc_load",
	"notepad_read",
	"webfetch",
]);

const SEARCH_TOOLS = new Set([
	"glob",
	"grep",
	"session_list",
	"session_search",
	"lsp_symbols",
	"lsp_find_references",
	"lsp_goto_definition",
	"ast_grep_search",
]);

const PLANNING_TOOLS = new Set([
	"todowrite",
	"plan_list",
	"plan_read",
	"plan_context_read",
	"plan_doc_list",
	"plan_doc_load",
	"notepad_read",
	"question",
]);

const EDIT_TOOLS = new Set([
	"edit",
	"write",
	"hash_anchored_edit",
	"apply_patch",
	"ast_grep_replace",
]);

function parseIso(input: unknown): string | undefined {
	return typeof input === "string" && input.trim().length > 0
		? input
		: undefined;
}

function normalizeMessages(data: unknown): SessionMessage[] {
	if (!Array.isArray(data)) return [];

	return data
		.filter(
			(entry): entry is Record<string, unknown> =>
				typeof entry === "object" && entry !== null,
		)
		.map((entry) => {
			const info =
				typeof entry.info === "object" && entry.info !== null
					? (entry.info as Record<string, unknown>)
					: {};
			const time =
				typeof info.time === "object" && info.time !== null
					? (info.time as Record<string, unknown>)
					: {};

			return {
				id: typeof entry.id === "string" ? entry.id : undefined,
				role: typeof info.role === "string" ? info.role : "unknown",
				created_at:
					parseIso(time.created) ??
					parseIso((entry as { created_at?: unknown }).created_at),
				parts: Array.isArray(entry.parts)
					? entry.parts.filter(
							(part): part is Record<string, unknown> =>
								typeof part === "object" && part !== null,
						)
					: [],
			};
		});
}

function normalizeToolName(part: Record<string, unknown>): string | null {
	const direct = part.tool;
	if (typeof direct === "string" && direct.trim().length > 0) {
		return direct.trim().toLowerCase();
	}

	const name = part.name;
	if (typeof name === "string" && name.trim().length > 0) {
		return name.trim().toLowerCase();
	}

	return null;
}

export function summarizeSessionActivity(
	data: unknown,
): SessionActivitySummary {
	const summary: SessionActivitySummary = {
		read_count: 0,
		search_count: 0,
		planning_count: 0,
		edit_count: 0,
		other_count: 0,
	};

	for (const message of normalizeMessages(data)) {
		for (const part of message.parts) {
			if (part.type !== "tool") continue;
			const toolName = normalizeToolName(part);
			if (!toolName) {
				summary.other_count += 1;
				continue;
			}

			if (EDIT_TOOLS.has(toolName)) {
				summary.edit_count += 1;
				continue;
			}

			if (SEARCH_TOOLS.has(toolName)) {
				summary.search_count += 1;
				continue;
			}

			if (PLANNING_TOOLS.has(toolName)) {
				summary.planning_count += 1;
				continue;
			}

			if (READ_TOOLS.has(toolName)) {
				summary.read_count += 1;
				continue;
			}

			summary.other_count += 1;
		}
	}

	return summary;
}

function formatToolState(part: Record<string, unknown>): string | null {
	const state =
		typeof part.state === "object" && part.state !== null
			? (part.state as Record<string, unknown>)
			: null;
	if (!state) return null;

	const output = typeof state.output === "string" ? state.output.trim() : "";
	if (output) return output;

	const error = typeof state.error === "string" ? state.error.trim() : "";
	if (error) return `ERROR: ${error}`;

	return null;
}

function formatParts(
	parts: Array<Record<string, unknown>>,
	options?: Pick<
		FullSessionFormatOptions,
		"includeThinking" | "includeToolResults"
	>,
): string[] {
	const lines: string[] = [];

	for (const part of parts) {
		const type = typeof part.type === "string" ? part.type : "unknown";

		if (type === "text" && typeof part.text === "string") {
			const text = part.text.trim();
			if (text) lines.push(text);
			continue;
		}

		if (
			type === "reasoning" &&
			options?.includeThinking &&
			typeof part.text === "string"
		) {
			const text = part.text.trim();
			if (text) lines.push(`[thinking]\n${text}`);
			continue;
		}

		if (type === "tool" && options?.includeToolResults) {
			const toolName = typeof part.tool === "string" ? part.tool : "tool";
			const toolOutput = formatToolState(part);
			if (toolOutput) {
				lines.push(`[tool:${toolName}]\n${toolOutput}`);
			}
		}
	}

	return lines;
}

export function extractLatestAssistantText(data: unknown): string | null {
	const messages = normalizeMessages(data)
		.filter((message) => message.role === "assistant")
		.reverse();

	for (const message of messages) {
		const text = formatParts(message.parts).join("\n\n").trim();
		if (text) return text;
	}

	return null;
}

export function extractPromptResponseText(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const parts = Array.isArray((data as { parts?: unknown }).parts)
		? ((data as { parts: unknown[] }).parts as unknown[])
		: [];

	const lines = formatParts(
		parts.filter(
			(part): part is Record<string, unknown> =>
				typeof part === "object" && part !== null,
		),
	);
	const text = lines.join("\n\n").trim();
	return text || null;
}

export function formatFullSession(
	data: unknown,
	options: FullSessionFormatOptions,
): string {
	const messages = normalizeMessages(data);
	const latestAssistantText = extractLatestAssistantText(data)?.trim();
	const resultText = options.task.result?.trim();
	const limited =
		typeof options.messageLimit === "number" &&
		Number.isFinite(options.messageLimit)
			? messages.slice(-Math.max(1, Math.floor(options.messageLimit)))
			: messages;

	const lines = [
		`Task ID: ${options.task.id}`,
		`Reference: ref:${options.task.id}`,
		`Session ID: ${options.task.child_session_id}`,
		`Status: ${options.task.status}`,
		`Agent: ${options.task.agent}`,
		"",
	];

	if (
		resultText &&
		(options.task.status === "succeeded" || options.task.status === "failed") &&
		resultText !== latestAssistantText
	) {
		lines.push("Latest result:");
		lines.push(resultText);
		lines.push("");
	}

	if (limited.length === 0) {
		lines.push("(No session messages yet)");
		return lines.join("\n");
	}

	for (const message of limited) {
		const header = [`### ${message.role}`];
		if (message.created_at) header.push(`@ ${message.created_at}`);
		lines.push(header.join(" "));

		const body = formatParts(message.parts, options).join("\n\n").trim();
		lines.push(body || "(No visible content)");
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}
