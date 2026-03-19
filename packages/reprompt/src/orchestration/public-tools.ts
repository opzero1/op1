import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { parseRepromptConfig, type RepromptConfig } from "../config.js";
import {
	createTelemetryStore,
	type TelemetryStore,
} from "../telemetry/events.js";
import type { RepromptTaskClass } from "../types.js";
import type { RetryGuardManager } from "./guards.js";
import { createRetryGuardManager } from "./guards.js";
import { normalizeRepromptArgs, prepareRepromptPrompt } from "./runtime.js";

type SessionClient = NonNullable<Parameters<Plugin>[0]["client"]>["session"];

type RepromptConfigOverride = Omit<
	Partial<RepromptConfig>,
	"runtime" | "retry" | "bundle" | "privacy" | "oracle" | "telemetry"
> & {
	runtime?: Partial<RepromptConfig["runtime"]>;
	retry?: Partial<RepromptConfig["retry"]>;
	bundle?: Partial<RepromptConfig["bundle"]>;
	privacy?: Partial<RepromptConfig["privacy"]>;
	oracle?: Partial<RepromptConfig["oracle"]>;
	telemetry?: Partial<RepromptConfig["telemetry"]>;
};

function formatDecision(args: {
	decision: string;
	reason: string;
	prompt: string;
	bundleTokenCount: number;
	evidenceCount: number;
	promptMode: "compiler";
	taskClass: RepromptTaskClass;
	omissionReasons: string[];
	responseText?: string;
}): string {
	const lines = [
		`decision: ${args.decision}`,
		`reason: ${args.reason}`,
		`prompt_mode: ${args.promptMode}`,
		`task_class: ${args.taskClass}`,
		`bundle_tokens: ${args.bundleTokenCount}`,
		`evidence_slices: ${args.evidenceCount}`,
		`omission_count: ${args.omissionReasons.length}`,
	];
	if (args.omissionReasons.length > 0) {
		lines.push(
			"",
			"omissions:",
			...args.omissionReasons.map((item) => `- ${item}`),
		);
	}
	if (args.responseText) {
		lines.push("", args.responseText.trim());
	} else {
		lines.push("", args.prompt);
	}
	return lines.join("\n");
}

export function createPublicRepromptTools(input: {
	workspaceRoot: string;
	client: { session: SessionClient };
	config?: RepromptConfigOverride;
	guards?: RetryGuardManager;
	telemetry?: TelemetryStore;
}): NonNullable<Hooks["tool"]> {
	const cfg = parseRepromptConfig({ enabled: true, ...input.config });
	const guards = input.guards ?? createRetryGuardManager();
	const telemetryLevel =
		cfg.telemetry.level === "off"
			? "off"
			: cfg.telemetry.level === "debug"
				? "debug"
				: "basic";
	const telemetry =
		input.telemetry ??
		createTelemetryStore({
			workspaceRoot: input.workspaceRoot,
			level: telemetryLevel,
			persistEvents: cfg.telemetry.persistEvents,
		});

	return {
		reprompt: tool({
			description:
				"Build a bounded grounding bundle and optionally execute one explicit child-session retry or planning-refinement pass.",
			args: {
				task_summary: tool.schema
					.string()
					.optional()
					.describe("What the agent is trying to do."),
				failure_summary: tool.schema
					.string()
					.optional()
					.describe("Why the first attempt needs a retry."),
				simple_prompt: tool.schema
					.string()
					.optional()
					.describe(
						"A terse user request to compile into a grounded GPT-5.4-ready retry prompt.",
					),
				success_criteria: tool.schema
					.array(tool.schema.string())
					.optional()
					.describe("Optional success criteria to preserve in compiler mode."),
				task_type: tool.schema
					.string()
					.optional()
					.describe(
						"Optional task-class hint such as implementation, debug, plan, or research.",
					),
				evidence_paths: tool.schema
					.array(tool.schema.string())
					.optional()
					.describe("Workspace-relative files to slice into the bundle."),
				failure_paths: tool.schema
					.array(tool.schema.string())
					.optional()
					.describe("Files directly implicated by the failure."),
				trigger_type: tool.schema
					.string()
					.optional()
					.describe("Retry trigger type, defaults to manual-helper-request."),
				agent: tool.schema
					.string()
					.optional()
					.describe("Child session agent to use when execute=true."),
				execute: tool.schema
					.boolean()
					.optional()
					.describe("Run the child-session retry immediately."),
			},
			async execute(args, toolCtx) {
				if (!cfg.enabled) {
					return "reprompt disabled: enable the plugin or set enabled=true in config";
				}

				const normalized = normalizeRepromptArgs(args, cfg);
				if ("error" in normalized) {
					return normalized.error;
				}

				const dedupeKey = guards.buildKey([
					toolCtx?.sessionID,
					normalized.taskSummary,
					normalized.failureSummary,
					...(args.failure_paths ?? []),
				]);
				const guard = guards.start({
					dedupeKey,
					maxAttempts: cfg.retry.maxAttempts,
					cooldownMs: cfg.retry.cooldownMs,
					recursionGuard: cfg.retry.recursionGuard,
				});
				if (!guard.allowed) {
					return `reprompt suppressed: ${guard.suppressionReason}`;
				}

				try {
					const prepared = await prepareRepromptPrompt({
						workspaceRoot: input.workspaceRoot,
						config: cfg,
						normalized,
						triggerSource: "tool",
						triggerType: args.trigger_type ?? "manual-helper-request",
						attempt: guard.attempt,
						maxAttempts: cfg.retry.maxAttempts,
						dedupeKey,
						evidencePaths: args.evidence_paths,
						failurePaths: args.failure_paths,
					});

					await telemetry.record({
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
						note:
							prepared.promptMode === "compiler"
								? `compiler-candidates:${prepared.compilerCandidateCount}`
								: undefined,
					});

					if (
						!args.execute ||
						prepared.decision.action === "suppress" ||
						prepared.decision.action === "fail-closed"
					) {
						await telemetry.record({
							eventType: "decision-made",
							triggerSource: prepared.decision.trigger.source,
							triggerType: prepared.decision.trigger.type,
							failureClass: prepared.decision.trigger.failureClass,
							includedTokens: prepared.bundle.includedTokens,
							evidenceCount: prepared.bundle.evidenceSlices.length,
							outcome: prepared.decision.action,
							suppressionReason: prepared.decision.suppressionReason,
							oracleUsed: prepared.decision.oracleRequired,
							taskClass: prepared.taskClass,
							promptMode: prepared.promptMode,
							omissionCount: prepared.omissionReasons.length,
						});
						return formatDecision({
							decision: prepared.decision.action,
							reason: prepared.decision.reason,
							prompt: prepared.prompt,
							bundleTokenCount: prepared.bundle.includedTokens,
							evidenceCount: prepared.bundle.evidenceSlices.length,
							promptMode: prepared.promptMode,
							taskClass: prepared.taskClass,
							omissionReasons: prepared.omissionReasons,
						});
					}

					const child = await input.client.session.create({
						body: {
							title: "Reprompt Helper Retry",
							parentID: toolCtx?.sessionID,
						},
					});
					const childId = (child.data as { id?: string } | undefined)?.id;
					if (!childId) {
						return "reprompt failed: could not create child session";
					}

					const response = await input.client.session.prompt({
						path: { id: childId },
						body: {
							agent: args.agent ?? "build",
							parts: [{ type: "text", text: prepared.prompt }],
						},
					});
					const responseText =
						typeof response.data === "object" &&
						response.data !== null &&
						Array.isArray((response.data as { parts?: unknown }).parts)
							? (
									response.data as {
										parts: Array<{ type: string; text?: string }>;
									}
								).parts
									.filter(
										(part) =>
											part.type === "text" && typeof part.text === "string",
									)
									.map((part) => part.text)
									.join("\n") || undefined
							: undefined;

					await telemetry.record({
						eventType: "retry-finished",
						triggerSource: prepared.decision.trigger.source,
						triggerType: prepared.decision.trigger.type,
						failureClass: prepared.decision.trigger.failureClass,
						includedTokens: prepared.bundle.includedTokens,
						evidenceCount: prepared.bundle.evidenceSlices.length,
						outcome: response.error ? "session-prompt-failed" : "succeeded",
						oracleUsed: prepared.decision.oracleRequired,
						taskClass: prepared.taskClass,
						promptMode: prepared.promptMode,
						omissionCount: prepared.omissionReasons.length,
					});
					return formatDecision({
						decision: prepared.decision.action,
						reason: prepared.decision.reason,
						prompt: prepared.prompt,
						bundleTokenCount: prepared.bundle.includedTokens,
						evidenceCount: prepared.bundle.evidenceSlices.length,
						promptMode: prepared.promptMode,
						taskClass: prepared.taskClass,
						omissionReasons: prepared.omissionReasons,
						responseText:
							response.error !== undefined
								? `reprompt execution failed: ${String(response.error)}`
								: responseText,
					});
				} catch (error) {
					return `reprompt execution failed: ${
						error instanceof Error ? error.message : String(error)
					}`;
				} finally {
					guards.finish(dedupeKey);
				}
			},
		}),
	};
}
