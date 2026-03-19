import type { RepromptConfig } from "../config.js";
import type { TelemetryStore } from "../telemetry/events.js";
import { compileNormalizedPrompt } from "./compile-output.js";
import type { RetryGuardManager } from "./guards.js";
import { classifyIncomingPrompt, normalizeRepromptArgs } from "./runtime.js";

type ChatMessageInput = {
	sessionID: string;
	agent?: string;
	messageID?: string;
	model?: { providerID?: string; modelID?: string };
	variant?: string;
};

type TextPart = {
	type: string;
	text?: string;
	id?: string;
	sessionID?: string;
	messageID?: string;
	[key: string]: unknown;
};

type ChatMessageOutput = {
	message?: Record<string, unknown>;
	parts: TextPart[];
};

export function createIncomingPromptHook(input: {
	workspaceRoot: string;
	config: RepromptConfig;
	guards: RetryGuardManager;
	telemetry: TelemetryStore;
}): (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void> {
	const seenSessions = new Set<string>();

	return async (hookInput, output) => {
		if (!input.config.enabled) return;
		if (input.config.runtime.mode !== "hook-and-helper") return;

		if (seenSessions.has(hookInput.sessionID)) {
			await input.telemetry.record({
				eventType: "incoming-processed",
				triggerSource: "hook",
				triggerType: "incoming-prompt",
				failureClass: "selection",
				outcome: "pass-through:non-first-message",
				note: hookInput.sessionID,
			});
			return;
		}
		seenSessions.add(hookInput.sessionID);

		const incoming = classifyIncomingPrompt({
			parts: output.parts,
			marker: input.config.runtime.triggerPrefix,
		});
		if (incoming.action !== "compile") {
			await input.telemetry.record({
				eventType: "incoming-processed",
				triggerSource: "hook",
				triggerType: "incoming-prompt",
				failureClass: "selection",
				outcome: `pass-through:${incoming.reason}`,
				note: hookInput.sessionID,
			});
			return;
		}

		const normalized = normalizeRepromptArgs(
			{
				task_summary: incoming.promptText,
				simple_prompt: incoming.promptText,
				failure_summary:
					"Rewrite this incoming prompt into a safer, more grounded execution prompt before agent execution.",
			},
			input.config,
		);
		if ("error" in normalized) {
			return;
		}

		await compileNormalizedPrompt({
			workspaceRoot: input.workspaceRoot,
			config: input.config,
			guards: input.guards,
			telemetry: input.telemetry,
			output,
			normalized,
			triggerSource: "hook",
			triggerType: "incoming-prompt",
			dedupeSegments: [
				"incoming-prompt",
				hookInput.sessionID,
				normalized.originalPrompt,
			],
			telemetryNote: hookInput.sessionID,
		});
	};
}
