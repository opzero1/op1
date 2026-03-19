import type { RepromptConfig } from "../config.js";
import type { TelemetryStore } from "../telemetry/events.js";
import type { RetryGuardManager } from "./guards.js";
import {
	classifyIncomingPrompt,
	normalizeRepromptArgs,
	prepareRepromptPrompt,
} from "./runtime.js";

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

function replaceTextParts(output: ChatMessageOutput, prompt: string): void {
	const first = output.parts.find((part) => part.type === "text");
	if (!first) return;
	output.parts.splice(0, output.parts.length, {
		...first,
		text: prompt,
	});
}

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

		const dedupeKey = input.guards.buildKey([
			"incoming-prompt",
			hookInput.sessionID,
			normalized.originalPrompt,
		]);
		const guard = input.guards.start({
			dedupeKey,
			maxAttempts: input.config.retry.maxAttempts,
			cooldownMs: input.config.retry.cooldownMs,
			recursionGuard: input.config.retry.recursionGuard,
		});
		if (!guard.allowed) {
			await input.telemetry.record({
				eventType: "incoming-processed",
				triggerSource: "hook",
				triggerType: "incoming-prompt",
				failureClass: "selection",
				outcome: "suppressed",
				suppressionReason: guard.suppressionReason,
				note: hookInput.sessionID,
			});
			return;
		}

		try {
			const prepared = await prepareRepromptPrompt({
				workspaceRoot: input.workspaceRoot,
				config: input.config,
				normalized,
				triggerSource: "hook",
				triggerType: "incoming-prompt",
				attempt: guard.attempt,
				maxAttempts: input.config.retry.maxAttempts,
				dedupeKey,
			});

			await input.telemetry.record({
				eventType: "bundle-built",
				triggerSource: prepared.decision.trigger.source,
				triggerType: prepared.decision.trigger.type,
				failureClass: prepared.decision.trigger.failureClass,
				includedTokens: prepared.bundle.includedTokens,
				evidenceCount: prepared.bundle.evidenceSlices.length,
				oracleUsed: prepared.decision.oracleRequired,
				taskClass: prepared.taskClass,
				promptMode: prepared.promptMode,
				omissionCount: prepared.omissionReasons.length,
				note: `incoming-candidates:${prepared.compilerCandidateCount}`,
			});

			if (
				prepared.decision.action === "suppress" ||
				prepared.decision.action === "fail-closed"
			) {
				replaceTextParts(output, prepared.prompt);
				await input.telemetry.record({
					eventType: "incoming-processed",
					triggerSource: prepared.decision.trigger.source,
					triggerType: prepared.decision.trigger.type,
					failureClass: prepared.decision.trigger.failureClass,
					includedTokens: prepared.bundle.includedTokens,
					evidenceCount: prepared.bundle.evidenceSlices.length,
					outcome: "fail-closed",
					suppressionReason:
						prepared.decision.suppressionReason ?? prepared.decision.reason,
					oracleUsed: prepared.decision.oracleRequired,
					taskClass: prepared.taskClass,
					promptMode: prepared.promptMode,
					omissionCount: prepared.omissionReasons.length,
				});
				return;
			}

			replaceTextParts(output, prepared.prompt);
			await input.telemetry.record({
				eventType: "incoming-processed",
				triggerSource: prepared.decision.trigger.source,
				triggerType: prepared.decision.trigger.type,
				failureClass: prepared.decision.trigger.failureClass,
				includedTokens: prepared.bundle.includedTokens,
				evidenceCount: prepared.bundle.evidenceSlices.length,
				outcome: "compiled",
				oracleUsed: prepared.decision.oracleRequired,
				taskClass: prepared.taskClass,
				promptMode: prepared.promptMode,
				omissionCount: prepared.omissionReasons.length,
			});
		} finally {
			input.guards.finish(dedupeKey);
		}
	};
}
