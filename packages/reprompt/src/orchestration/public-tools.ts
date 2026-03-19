import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { parseRepromptConfig, type RepromptConfig } from "../config.js";
import { decideRepromptAction } from "../selection/confidence.js";
import { rankEvidenceSlices } from "../selection/evidence-ranker.js";
import { resolveOraclePolicy } from "../selection/oracle-policy.js";
import { buildGroundingBundle } from "../serializer/bundle.js";
import { buildCodeMapLite } from "../serializer/codemap-lite.js";
import { collectRepoSnapshot } from "../serializer/repo-snapshot.js";
import {
	collectEvidenceSlices,
	type SliceRequest,
} from "../serializer/slices.js";
import { createTelemetryStore } from "../telemetry/events.js";
import type { RepromptTaskClass } from "../types.js";
import { buildCompilerContextPlan } from "./context-builder.js";
import { createRetryGuardManager } from "./guards.js";
import { buildCompilerPrompt, buildRetryPrompt } from "./prompt-builder.js";
import { classifyRepromptTask } from "./task-classifier.js";
import { createRetryTrigger } from "./triggers.js";

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
	promptMode: "legacy" | "compiler";
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

function buildSliceRequests(paths: string[], reason: string): SliceRequest[] {
	return paths.map((path) => ({
		kind: "file" as const,
		path,
		reason,
		contextBefore: 10,
		contextAfter: 10,
	}));
}

function selectedPromptMode(args: {
	simple_prompt?: string;
	success_criteria?: string[];
	task_type?: string;
	config: RepromptConfig;
}): "legacy" | "compiler" {
	if (args.config.runtime.promptMode === "legacy") {
		return "legacy";
	}
	if (args.config.runtime.promptMode === "compiler") {
		return "compiler";
	}
	return args.simple_prompt || args.task_type || args.success_criteria?.length
		? "compiler"
		: "legacy";
}

function normalizeArgs(
	args: {
		task_summary?: string;
		failure_summary?: string;
		simple_prompt?: string;
		success_criteria?: string[];
		task_type?: string;
	},
	config: RepromptConfig,
):
	| {
			failureSummary: string;
			originalPrompt: string;
			promptMode: "legacy" | "compiler";
			successCriteria: string[];
			taskSummary: string;
			taskTypeHint?: string;
	  }
	| { error: string } {
	const promptMode = selectedPromptMode({
		simple_prompt: args.simple_prompt,
		success_criteria: args.success_criteria,
		task_type: args.task_type,
		config,
	});
	const taskSummary = args.task_summary?.trim() || args.simple_prompt?.trim();
	if (!taskSummary) {
		return {
			error:
				"reprompt failed: provide task_summary for legacy mode or simple_prompt for compiler mode",
		};
	}
	const originalPrompt = args.simple_prompt?.trim() || taskSummary;
	const successCriteria = (args.success_criteria ?? [])
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.slice(0, 6);
	const failureSummary =
		args.failure_summary?.trim() ||
		(promptMode === "compiler"
			? "Compile the terse request into a grounded GPT-5.4-ready prompt or planning-refinement brief using bounded local context and explicit omission reporting."
			: "Need one bounded retry with the available local evidence.");

	return {
		failureSummary,
		originalPrompt,
		promptMode,
		successCriteria,
		taskSummary,
		taskTypeHint: args.task_type?.trim() || undefined,
	};
}

export function createPublicRepromptTools(input: {
	workspaceRoot: string;
	client: { session: SessionClient };
	config?: RepromptConfigOverride;
}): NonNullable<Hooks["tool"]> {
	const cfg = parseRepromptConfig({ enabled: true, ...input.config });
	const guards = createRetryGuardManager();
	const telemetryLevel =
		cfg.telemetry.level === "off"
			? "off"
			: cfg.telemetry.level === "debug"
				? "debug"
				: "basic";
	const oracleMode =
		cfg.oracle.mode === "disabled"
			? "disabled"
			: cfg.oracle.mode === "allow"
				? "allow"
				: "suggest";
	const telemetry = createTelemetryStore({
		workspaceRoot: input.workspaceRoot,
		level: telemetryLevel,
		persistEvents: cfg.telemetry.persistEvents,
	});

	return {
		reprompt_retry: tool({
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
				if (cfg.runtime.killSwitch) {
					return "reprompt suppressed: kill switch is enabled";
				}

				const normalized = normalizeArgs(args, cfg);
				if ("error" in normalized) {
					return normalized.error;
				}

				const dedupeKey = guards.buildKey([
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
					const trigger = createRetryTrigger({
						source: "tool",
						type: args.trigger_type ?? "manual-helper-request",
						failureMessage: normalized.failureSummary,
						attempt: guard.attempt,
						maxAttempts: cfg.retry.maxAttempts,
						dedupeKey,
						path: args.failure_paths?.[0],
					});
					const taskClass = classifyRepromptTask({
						promptText: normalized.originalPrompt,
						failureSummary: normalized.failureSummary,
						taskTypeHint: normalized.taskTypeHint,
						trigger,
					});

					const snapshot = await collectRepoSnapshot(input.workspaceRoot);
					const codeMap = await buildCodeMapLite(input.workspaceRoot, snapshot);
					const compilerContext =
						normalized.promptMode === "compiler"
							? buildCompilerContextPlan({
									trigger,
									taskClass,
									promptText: normalized.originalPrompt,
									failureSummary: normalized.failureSummary,
									evidencePaths: args.evidence_paths,
									failurePaths: args.failure_paths,
									snapshot,
									codeMap,
								})
							: null;
					const requests = compilerContext?.requests ?? [
						...buildSliceRequests(
							args.evidence_paths ?? [],
							"explicit evidence path",
						),
						...(args.failure_paths ?? []).map((path) => ({
							kind: "failure" as const,
							path,
							reason: "failure path",
							message: normalized.failureSummary,
							contextBefore: 12,
							contextAfter: 12,
						})),
					];
					const collectedSlices = await collectEvidenceSlices(
						input.workspaceRoot,
						requests,
					);
					const slices = compilerContext
						? [...compilerContext.contextSlices, ...collectedSlices]
						: collectedSlices;
					const ranked = rankEvidenceSlices({
						taskSummary: normalized.taskSummary,
						failureSummary: normalized.failureSummary,
						slices,
						budget: cfg.bundle,
						privacy: cfg.privacy,
						recentPaths: snapshot.diff.map((entry) => entry.path),
						failurePaths: args.failure_paths,
					});
					const bundle = buildGroundingBundle({
						taskSummary: normalized.taskSummary,
						failureSummary: normalized.failureSummary,
						slices: ranked.evidenceSlices,
						budget: cfg.bundle,
						baseOmittedReasons: ranked.omittedReasons,
						recentPaths: snapshot.diff.map((entry) => entry.path),
						failurePaths: args.failure_paths,
						provenance: [
							...snapshot.diff.map((entry) => `diff:${entry.path}`),
							...codeMap.files.map((file) => `codemap:${file.path}`),
						],
					});
					const oracleDecision = resolveOraclePolicy({
						mode: oracleMode,
						maxBundleTokens: cfg.oracle.maxBundleTokens,
						maxCallsPerSession: cfg.oracle.maxCallsPerSession,
						sessionOracleCalls: 0,
						oracleAvailable: false,
						confidence: ranked.evidenceSlices.length >= 3 ? 0.65 : 0.35,
						includedTokens: bundle.includedTokens,
						trigger,
					});
					const decision = decideRepromptAction({
						trigger,
						bundle,
						oracleDecision,
					});
					const decisionWithTaskClass = { ...decision, taskClass };
					const omissionReasons = [
						...new Set([
							...(compilerContext?.omissionReasons ?? []),
							...bundle.omittedReasons,
						]),
					];
					const prompt =
						normalized.promptMode === "compiler"
							? buildCompilerPrompt({
									originalPrompt: normalized.originalPrompt,
									taskSummary: normalized.taskSummary,
									failureSummary: normalized.failureSummary,
									taskClass,
									bundle,
									decision: decisionWithTaskClass,
									successCriteria: normalized.successCriteria,
									omissionReasons,
									retryDiagnostics: bundle.omittedReasons,
								})
							: buildRetryPrompt({
									taskSummary: normalized.taskSummary,
									failureSummary: normalized.failureSummary,
									bundle,
									decision: decisionWithTaskClass,
									retryDiagnostics: bundle.omittedReasons,
								});

					await telemetry.record({
						eventType: "bundle-built",
						triggerSource: trigger.source,
						triggerType: trigger.type,
						failureClass: trigger.failureClass,
						includedTokens: bundle.includedTokens,
						evidenceCount: bundle.evidenceSlices.length,
						oracleUsed: decision.oracleRequired,
						taskClass,
						promptMode: normalized.promptMode,
						omissionCount: omissionReasons.length,
						note:
							normalized.promptMode === "compiler"
								? `compiler-candidates:${compilerContext?.candidatePaths.length ?? 0}`
								: undefined,
					});

					if (
						!args.execute ||
						decision.action === "suppress" ||
						decision.action === "fail-closed"
					) {
						await telemetry.record({
							eventType: "decision-made",
							triggerSource: trigger.source,
							triggerType: trigger.type,
							failureClass: trigger.failureClass,
							includedTokens: bundle.includedTokens,
							evidenceCount: bundle.evidenceSlices.length,
							outcome: decision.action,
							suppressionReason: decision.suppressionReason,
							oracleUsed: decision.oracleRequired,
							taskClass,
							promptMode: normalized.promptMode,
							omissionCount: omissionReasons.length,
						});
						return formatDecision({
							decision: decision.action,
							reason: decision.reason,
							prompt,
							bundleTokenCount: bundle.includedTokens,
							evidenceCount: bundle.evidenceSlices.length,
							promptMode: normalized.promptMode,
							taskClass,
							omissionReasons,
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
							parts: [{ type: "text", text: prompt }],
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
						triggerSource: trigger.source,
						triggerType: trigger.type,
						failureClass: trigger.failureClass,
						includedTokens: bundle.includedTokens,
						evidenceCount: bundle.evidenceSlices.length,
						outcome: response.error ? String(response.error) : "succeeded",
						oracleUsed: decision.oracleRequired,
						taskClass,
						promptMode: normalized.promptMode,
						omissionCount: omissionReasons.length,
					});
					return formatDecision({
						decision: decision.action,
						reason: decision.reason,
						prompt,
						bundleTokenCount: bundle.includedTokens,
						evidenceCount: bundle.evidenceSlices.length,
						promptMode: normalized.promptMode,
						taskClass,
						omissionReasons,
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
