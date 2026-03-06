import type { FullSessionFormatOptions, SessionMessage } from "./types.js";

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
