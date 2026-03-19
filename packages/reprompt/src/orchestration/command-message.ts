import type { RepromptConfig } from "../config.js";
import type { TelemetryStore } from "../telemetry/events.js";
import { compileNormalizedPrompt } from "./compile-output.js";
import type { RetryGuardManager } from "./guards.js";
import {
	extractPromptText,
	normalizeRepromptArgs,
	parseCommandTriggerArgs,
} from "./runtime.js";

type CommandExecuteBeforeInput = {
	command: string;
	sessionID: string;
	arguments: string;
};

type TextPart = {
	type: string;
	text?: string;
	[key: string]: unknown;
};

type CommandExecuteBeforeOutput = {
	parts: TextPart[];
};

function sanitizeCommandParts(
	parts: TextPart[],
	rawArgs: string,
	sanitizedArgs: string,
): TextPart[] {
	if (!rawArgs || rawArgs === sanitizedArgs) return parts;
	return parts.map((part) => {
		if (part.type !== "text" || typeof part.text !== "string") return part;
		return {
			...part,
			text: part.text.split(rawArgs).join(sanitizedArgs),
		};
	});
}

function buildCommandSummary(command: string, args: string): string {
	return args ? `/${command} ${args}` : `/${command}`;
}

export function createCommandPromptHook(input: {
	workspaceRoot: string;
	config: RepromptConfig;
	guards: RetryGuardManager;
	telemetry: TelemetryStore;
}): (
	input: CommandExecuteBeforeInput,
	output: CommandExecuteBeforeOutput,
) => Promise<void> {
	return async (hookInput, output) => {
		if (!input.config.enabled) return;
		if (input.config.runtime.mode !== "hook-and-helper") return;

		const trigger = parseCommandTriggerArgs(
			hookInput.arguments,
			input.config.runtime.triggerPrefix,
		);
		if (!trigger.opxEnabled) return;

		const sanitizedParts = sanitizeCommandParts(
			output.parts,
			trigger.rawArgs,
			trigger.sanitizedArgs,
		);
		const promptText = extractPromptText(sanitizedParts);
		if (!promptText) return;

		output.parts.splice(0, output.parts.length, ...sanitizedParts);

		const normalized = normalizeRepromptArgs(
			{
				task_summary: buildCommandSummary(
					hookInput.command,
					trigger.sanitizedArgs,
				),
				simple_prompt: promptText,
				failure_summary:
					"Rewrite this slash-command prompt into a safer, more grounded execution prompt before agent execution.",
				task_type: hookInput.command,
			},
			input.config,
		);
		if ("error" in normalized) return;

		await compileNormalizedPrompt({
			workspaceRoot: input.workspaceRoot,
			config: input.config,
			guards: input.guards,
			telemetry: input.telemetry,
			output,
			normalized,
			triggerSource: "hook",
			triggerType: "command-prompt",
			dedupeSegments: [
				"command-prompt",
				hookInput.sessionID,
				hookInput.command,
				normalized.originalPrompt,
			],
			telemetryNote: `command:${hookInput.command}`,
		});
	};
}
