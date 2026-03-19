import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TelemetryLevel } from "../config.js";
import { redactText } from "../redaction.js";

export type RepromptTelemetryEventType =
	| "bundle-built"
	| "decision-made"
	| "retry-finished";

export interface RepromptTelemetryEvent {
	timestamp: string;
	eventType: RepromptTelemetryEventType;
	triggerSource: string;
	triggerType: string;
	failureClass: string;
	taskClass?: string;
	promptMode?: string;
	includedTokens?: number;
	evidenceCount?: number;
	omissionCount?: number;
	outcome?: string;
	suppressionReason?: string;
	oracleUsed?: boolean;
	note?: string;
}

export interface TelemetryStore {
	record(event: Omit<RepromptTelemetryEvent, "timestamp">): Promise<void>;
	list(limit?: number): Promise<RepromptTelemetryEvent[]>;
	path: string;
}

function telemetryPath(workspaceRoot: string): string {
	return join(workspaceRoot, ".opencode", "reprompt", "events.jsonl");
}

export function createTelemetryStore(input: {
	workspaceRoot: string;
	level: TelemetryLevel;
	persistEvents: boolean;
}): TelemetryStore {
	const path = telemetryPath(input.workspaceRoot);
	let queue = Promise.resolve();

	return {
		path,

		async record(event) {
			if (input.level === "off" || !input.persistEvents) return;
			const payload: RepromptTelemetryEvent = {
				timestamp: new Date().toISOString(),
				eventType: event.eventType,
				triggerSource: redactText(event.triggerSource),
				triggerType: redactText(event.triggerType),
				failureClass: redactText(event.failureClass),
				taskClass: event.taskClass ? redactText(event.taskClass) : undefined,
				promptMode: event.promptMode ? redactText(event.promptMode) : undefined,
				includedTokens: event.includedTokens,
				evidenceCount: event.evidenceCount,
				omissionCount: event.omissionCount,
				outcome: event.outcome ? redactText(event.outcome) : undefined,
				suppressionReason: event.suppressionReason
					? redactText(event.suppressionReason)
					: undefined,
				oracleUsed: event.oracleUsed,
				note:
					input.level === "debug" && event.note
						? redactText(event.note)
						: undefined,
			};

			queue = queue.then(async () => {
				await mkdir(join(input.workspaceRoot, ".opencode", "reprompt"), {
					recursive: true,
				});
				const file = Bun.file(path);
				const existing = (await file.exists()) ? await file.text() : "";
				await Bun.write(path, `${existing}${JSON.stringify(payload)}\n`);
			});

			await queue;
		},

		async list(limit = 50) {
			if (!input.persistEvents) return [];
			const file = Bun.file(path);
			if (!(await file.exists())) return [];
			const content = await file.text();
			return content
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.slice(-limit)
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as RepromptTelemetryEvent];
					} catch {
						return [];
					}
				});
		},
	};
}
