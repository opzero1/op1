import type { RepromptConfig } from "../config.js";
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
import type {
	GroundingBundle,
	RepromptDecision,
	RepromptTaskClass,
	RetryTriggerSource,
} from "../types.js";
import { buildCompilerContextPlan } from "./context-builder.js";
import {
	buildCompilerPrompt,
	buildFailClosedPrompt,
	hasRepromptPromptMarker,
} from "./prompt-builder.js";
import { classifyRepromptTask } from "./task-classifier.js";
import { createRetryTrigger } from "./triggers.js";

export interface NormalizedRepromptArgs {
	failureSummary: string;
	originalPrompt: string;
	promptMode: "compiler";
	successCriteria: string[];
	taskSummary: string;
	taskTypeHint?: string;
}

export interface PreparedRepromptPrompt {
	bundle: GroundingBundle;
	decision: RepromptDecision;
	omissionReasons: string[];
	prompt: string;
	promptMode: "compiler";
	taskClass: RepromptTaskClass;
	normalized: NormalizedRepromptArgs;
	retryDiagnostics: string[];
	compilerCandidateCount: number;
}

export interface IncomingPromptDecision {
	action: "compile" | "pass-through";
	reason: string;
	promptText: string;
}

export interface CommandTriggerDecision {
	rawArgs: string;
	sanitizedArgs: string;
	opxEnabled: boolean;
}

const CASUAL_PROMPT_PATTERNS = [
	/^(?:hi|hiya|hello|hey|yo|sup)[!.?]*$/i,
	/^good\s+(?:morning|afternoon|evening)[!.?]*$/i,
	/^how(?:'s| is) it going\??$/i,
	/^how are you\??$/i,
	/^what(?:'s| is) up\??$/i,
	/^(?:thanks|thank you)[!.?]*$/i,
	/^(?:ok|okay|cool|nice|sounds good)[!.?]*$/i,
];

function isCasualPrompt(promptText: string): boolean {
	const normalized = promptText.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.length > 80) return false;
	return CASUAL_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function stripTrigger(promptText: string, marker: string): string | null {
	const raw = marker.trim();
	if (!raw) return null;
	const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const texts = [promptText.trim()];
	const quoted = promptText.trim().match(/^(["'])([\s\S]*)\1$/);
	if (quoted?.[2]) texts.push(quoted[2].trim());
	for (const text of texts) {
		const prefixMatch = text.match(
			new RegExp(`^${escaped}(?::|\\s+)([\\s\\S]*)$`, "i"),
		);
		if (prefixMatch) {
			return prefixMatch[1]?.trim() ?? "";
		}

		const suffixMatch = text.match(
			new RegExp(`^([\\s\\S]*?)\\s+${escaped}$`, "i"),
		);
		if (suffixMatch) {
			return suffixMatch[1]?.trim() ?? "";
		}
	}
	return null;
}

export function parseCommandTriggerArgs(
	args: string | undefined,
	marker: string,
): CommandTriggerDecision {
	const rawArgs = args?.trim() ?? "";
	const normalizedMarker = marker.trim().toLowerCase();
	if (!normalizedMarker || !rawArgs) {
		return {
			rawArgs,
			sanitizedArgs: rawArgs,
			opxEnabled: false,
		};
	}

	if (rawArgs.toLowerCase() === normalizedMarker) {
		return {
			rawArgs,
			sanitizedArgs: "",
			opxEnabled: true,
		};
	}

	const escaped = normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const prefix = rawArgs.match(
		new RegExp(`^${escaped}(?::|\\s+)([\\s\\S]*)$`, "i"),
	);
	if (prefix) {
		return {
			rawArgs,
			sanitizedArgs: prefix[1]?.trim() ?? "",
			opxEnabled: true,
		};
	}

	const matched = rawArgs.match(new RegExp(`^(.*)\\s+${escaped}$`, "i"));
	if (!matched) {
		return {
			rawArgs,
			sanitizedArgs: rawArgs,
			opxEnabled: false,
		};
	}

	return {
		rawArgs,
		sanitizedArgs: matched[1]?.trim() ?? "",
		opxEnabled: true,
	};
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

export function normalizeRepromptArgs(
	args: {
		task_summary?: string;
		failure_summary?: string;
		simple_prompt?: string;
		success_criteria?: string[];
		task_type?: string;
	},
	_config: RepromptConfig,
): NormalizedRepromptArgs | { error: string } {
	const taskSummary = args.task_summary?.trim() || args.simple_prompt?.trim();
	if (!taskSummary) {
		return {
			error: "reprompt failed: provide task_summary or simple_prompt",
		};
	}
	const originalPrompt = args.simple_prompt?.trim() || taskSummary;
	const successCriteria = (args.success_criteria ?? [])
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.slice(0, 6);
	const failureSummary =
		args.failure_summary?.trim() ||
		"Compile the terse request into a grounded GPT-5.4-ready prompt or planning-refinement brief using bounded local context and explicit omission reporting.";

	return {
		failureSummary,
		originalPrompt,
		promptMode: "compiler",
		successCriteria,
		taskSummary,
		taskTypeHint: args.task_type?.trim() || undefined,
	};
}

export function extractPromptText(
	parts: Array<{ type: string; text?: string }>,
): string {
	return parts
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text?.trim() ?? "")
		.filter((part) => part.length > 0)
		.join("\n")
		.trim();
}

export function classifyIncomingPrompt(input: {
	parts: Array<{ type: string; text?: string }>;
	marker?: string;
}): IncomingPromptDecision {
	if (input.parts.some((part) => part.type !== "text")) {
		return {
			action: "pass-through",
			reason: "non-text-parts",
			promptText: "",
		};
	}

	const promptText = extractPromptText(input.parts);
	if (!promptText) {
		return { action: "pass-through", reason: "empty-text", promptText };
	}

	if (hasRepromptPromptMarker(promptText)) {
		return { action: "pass-through", reason: "reprompt-origin", promptText };
	}

	if (promptText.startsWith("/")) {
		return { action: "pass-through", reason: "slash-command", promptText };
	}

	const text = stripTrigger(promptText, input.marker?.trim() || "opx");
	if (text === null) {
		return { action: "pass-through", reason: "no-trigger-marker", promptText };
	}
	if (!text) {
		return { action: "pass-through", reason: "empty-trigger", promptText: "" };
	}

	if (isCasualPrompt(text)) {
		return {
			action: "pass-through",
			reason: "casual-prompt",
			promptText: text,
		};
	}

	const structuredSignals = [
		/```/m,
		/<[a-z][^>]*>/im,
		/^#{1,6}\s/m,
		/^\s*[-*]\s/m,
		/^\s*\d+\.\s/m,
		/^\|.+\|/m,
		/<output_contract>|<grounding_context>|<task_brief>/m,
	].some((pattern) => pattern.test(text));
	const lineCount = text.split(/\n+/).filter(Boolean).length;
	const wordCount = text.split(/\s+/).filter(Boolean).length;

	if (wordCount <= 24) {
		return { action: "compile", reason: "terse-prompt", promptText: text };
	}

	if (!structuredSignals && lineCount <= 4 && wordCount <= 80) {
		return {
			action: "compile",
			reason: "underspecified-prompt",
			promptText: text,
		};
	}

	if (text.length > 700 || lineCount > 8) {
		return {
			action: "compile",
			reason: "explicit-marker-long-form",
			promptText: text,
		};
	}

	if (structuredSignals || lineCount > 1) {
		return {
			action: "compile",
			reason: "explicit-marker-structured",
			promptText: text,
		};
	}

	return {
		action: "pass-through",
		reason: "not-confident-enough",
		promptText: text,
	};
}

export async function prepareRepromptPrompt(input: {
	workspaceRoot: string;
	config: RepromptConfig;
	normalized: NormalizedRepromptArgs;
	triggerSource: RetryTriggerSource;
	triggerType: string;
	attempt: number;
	maxAttempts: number;
	dedupeKey: string;
	evidencePaths?: string[];
	failurePaths?: string[];
}): Promise<PreparedRepromptPrompt> {
	const trigger = createRetryTrigger({
		source: input.triggerSource,
		type: input.triggerType,
		failureMessage: input.normalized.failureSummary,
		attempt: input.attempt,
		maxAttempts: input.maxAttempts,
		dedupeKey: input.dedupeKey,
		path: input.failurePaths?.[0],
	});
	const taskClass = classifyRepromptTask({
		promptText: input.normalized.originalPrompt,
		failureSummary: input.normalized.failureSummary,
		taskTypeHint: input.normalized.taskTypeHint,
		trigger,
	});

	const snapshot = await collectRepoSnapshot(input.workspaceRoot);
	const codeMap = await buildCodeMapLite(input.workspaceRoot, snapshot);
	const compilerContext =
		input.normalized.promptMode === "compiler"
			? buildCompilerContextPlan({
					trigger,
					taskClass,
					promptText: input.normalized.originalPrompt,
					failureSummary: input.normalized.failureSummary,
					evidencePaths: input.evidencePaths,
					failurePaths: input.failurePaths,
					snapshot,
					codeMap,
				})
			: null;
	const requests = compilerContext?.requests ?? [
		...buildSliceRequests(input.evidencePaths ?? [], "explicit evidence path"),
		...(input.failurePaths ?? []).map((path) => ({
			kind: "failure" as const,
			path,
			reason: "failure path",
			message: input.normalized.failureSummary,
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
		taskSummary: input.normalized.taskSummary,
		failureSummary: input.normalized.failureSummary,
		slices,
		budget: input.config.bundle,
		privacy: input.config.privacy,
		recentPaths: snapshot.diff.map((entry) => entry.path),
		failurePaths: input.failurePaths,
	});
	const bundle = buildGroundingBundle({
		taskSummary: input.normalized.taskSummary,
		failureSummary: input.normalized.failureSummary,
		slices: ranked.evidenceSlices,
		budget: input.config.bundle,
		baseOmittedReasons: ranked.omittedReasons,
		recentPaths: snapshot.diff.map((entry) => entry.path),
		failurePaths: input.failurePaths,
		provenance: [
			...snapshot.diff.map((entry) => `diff:${entry.path}`),
			...codeMap.files.map((file) => `codemap:${file.path}`),
		],
	});
	const oracleMode =
		input.config.oracle.mode === "disabled"
			? "disabled"
			: input.config.oracle.mode === "allow"
				? "allow"
				: "suggest";
	const oracleDecision = resolveOraclePolicy({
		mode: oracleMode,
		maxBundleTokens: input.config.oracle.maxBundleTokens,
		maxCallsPerSession: input.config.oracle.maxCallsPerSession,
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
	const retryDiagnostics = bundle.omittedReasons;
	const prompt =
		decision.action === "retry-helper" ||
		decision.action === "retry-helper-with-oracle"
			? buildCompilerPrompt({
					originalPrompt: input.normalized.originalPrompt,
					taskSummary: input.normalized.taskSummary,
					failureSummary: input.normalized.failureSummary,
					taskClass,
					bundle,
					decision: decisionWithTaskClass,
					successCriteria: input.normalized.successCriteria,
					omissionReasons,
					retryDiagnostics,
				})
			: buildFailClosedPrompt({
					originalPrompt: input.normalized.originalPrompt,
					taskSummary: input.normalized.taskSummary,
					taskClass,
					reason: decision.reason,
					omissionReasons,
				});

	return {
		bundle,
		decision: decisionWithTaskClass,
		omissionReasons,
		prompt,
		promptMode: input.normalized.promptMode,
		taskClass,
		normalized: input.normalized,
		retryDiagnostics,
		compilerCandidateCount: compilerContext?.candidatePaths.length ?? 0,
	};
}
