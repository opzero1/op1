import type { RepromptConfig } from "../config.js";
import type { TelemetryStore } from "../telemetry/events.js";
import type { RetryGuardManager } from "./guards.js";
import {
	type NormalizedRepromptArgs,
	prepareRepromptPrompt,
} from "./runtime.js";

type TextPart = {
	type: string;
	text?: string;
	id?: string;
	sessionID?: string;
	messageID?: string;
	[key: string]: unknown;
};

type TextOutput = {
	parts: TextPart[];
};

export function replaceTextParts(output: TextOutput, prompt: string): boolean {
	const first = output.parts.find((part) => part.type === "text");
	if (!first) return false;
	output.parts.splice(0, output.parts.length, {
		...first,
		text: prompt,
	});
	return true;
}

export async function compileNormalizedPrompt(input: {
	workspaceRoot: string;
	config: RepromptConfig;
	guards: RetryGuardManager;
	telemetry: TelemetryStore;
	output: TextOutput;
	normalized: NormalizedRepromptArgs;
	triggerType: string;
	triggerSource: "hook";
	dedupeSegments: string[];
	telemetryNote?: string;
}): Promise<boolean> {
	const dedupeKey = input.guards.buildKey(input.dedupeSegments);
	const guard = input.guards.start({
		dedupeKey,
		maxAttempts: input.config.retry.maxAttempts,
		cooldownMs: input.config.retry.cooldownMs,
		recursionGuard: input.config.retry.recursionGuard,
	});
	if (!guard.allowed) {
		await input.telemetry.record({
			eventType: "incoming-processed",
			triggerSource: input.triggerSource,
			triggerType: input.triggerType,
			failureClass: "selection",
			outcome: "suppressed",
			suppressionReason: guard.suppressionReason,
			note: input.telemetryNote,
		});
		return false;
	}

	try {
		const prepared = await prepareRepromptPrompt({
			workspaceRoot: input.workspaceRoot,
			config: input.config,
			normalized: input.normalized,
			triggerSource: input.triggerSource,
			triggerType: input.triggerType,
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
			note: input.telemetryNote,
		});

		const replaced = replaceTextParts(input.output, prepared.prompt);
		if (!replaced) {
			return false;
		}

		if (
			prepared.decision.action === "suppress" ||
			prepared.decision.action === "fail-closed"
		) {
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
				note: input.telemetryNote,
			});
			return true;
		}

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
			note: input.telemetryNote,
		});
		return true;
	} finally {
		input.guards.finish(dedupeKey);
	}
}
