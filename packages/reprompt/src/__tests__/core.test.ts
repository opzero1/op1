import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompilerContextPlan } from "../orchestration/context-builder.js";
import { createRetryGuardManager } from "../orchestration/guards.js";
import { buildCompilerPrompt } from "../orchestration/prompt-builder.js";
import {
	classifyIncomingPrompt,
	extractPromptText,
	parseCommandTriggerArgs,
} from "../orchestration/runtime.js";
import { extractPromptHints } from "../orchestration/task-classifier.js";
import { createRetryTrigger } from "../orchestration/triggers.js";
import { canonicalizeParsedEdits } from "../patching/canonicalize.js";
import { recoverParsedEdits } from "../patching/recovery.js";
import { validatePatchCandidate } from "../patching/validate.js";
import { rankEvidenceSlices } from "../selection/evidence-ranker.js";
import { buildGroundingBundle } from "../serializer/bundle.js";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots.length = 0;
});

describe("reprompt core", () => {
	test("ranks evidence with privacy filtering and redaction", () => {
		const ranked = rankEvidenceSlices({
			taskSummary: "fix auth header handling",
			failureSummary: "token leaked in output",
			slices: [
				{
					id: "a",
					kind: "file-slice",
					path: "src/auth.ts",
					reason: "primary failure path",
					excerpt: "authorization=bearer abc123token",
					tokenCount: 6,
					provenance: "src/auth.ts:1-2",
					redacted: false,
				},
				{
					id: "b",
					kind: "file-slice",
					path: ".env",
					reason: "secret file",
					excerpt: "API_KEY=secret",
					tokenCount: 3,
					provenance: ".env:1-1",
					redacted: false,
				},
			],
			budget: { maxTokens: 50, maxBytes: 400, maxSlices: 4 },
			privacy: {
				blockedGlobs: [".env"],
				blockedPatterns: [],
				redactPatterns: ["abc123token"],
				allowHiddenFiles: false,
			},
		});

		expect(ranked.evidenceSlices).toHaveLength(1);
		expect(ranked.evidenceSlices[0]?.excerpt).toContain("[REDACTED]");
		expect(ranked.omittedReasons).toContain("privacy-blocked:.env");
	});

	test("builds fallback grounding bundle when slices are empty", () => {
		const bundle = buildGroundingBundle({
			taskSummary: "fix parser",
			failureSummary: "no local evidence",
			slices: [],
			budget: { maxTokens: 100, maxBytes: 1000, maxSlices: 4 },
		});

		expect(bundle.evidenceSlices).toHaveLength(1);
		expect(bundle.omittedReasons).toContain("no-eligible-local-evidence");
	});

	test("preserves upstream omission reasons in the final bundle", () => {
		const bundle = buildGroundingBundle({
			taskSummary: "fix parser",
			failureSummary: "bundle budget trimmed evidence",
			slices: [],
			budget: { maxTokens: 100, maxBytes: 1000, maxSlices: 4 },
			baseOmittedReasons: ["privacy-blocked:secret.ts"],
		});

		expect(bundle.omittedReasons).toContain("privacy-blocked:secret.ts");
		expect(bundle.omittedReasons).toContain("no-eligible-local-evidence");
	});

	test("recovers trailing commas and partial search replace blocks", () => {
		const recovered = recoverParsedEdits(
			'{"path":"src/app.ts","operation":"update","replacement":"x",}',
		);
		expect(recovered.recoverySteps).toContain("cleanupTrailingCommas");
		expect(recovered.edits[0]?.path).toBe("src/app.ts");

		const searchReplace = recoverParsedEdits(
			"<<<<<<< SEARCH path=src/app.ts\nold\n=======\nnew",
		);
		expect(searchReplace.recoverySteps).toContain("salvageSearchReplace");
		expect(searchReplace.edits[0]?.sourceFormat).toBe("search-replace");
	});

	test("validates deterministic search replace anchors", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-validate-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "alpha\nbeta\ngamma\n");

		const canonical = canonicalizeParsedEdits([
			{
				sourceFormat: "search-replace",
				path: "src.ts",
				operation: "update",
				searchText: "beta",
				replacement: "delta",
				rawText: "raw",
			},
		]);
		const candidate = canonical.candidates[0];
		expect(candidate).toBeDefined();
		if (!candidate) {
			throw new Error("expected canonical candidate");
		}
		const validated = await validatePatchCandidate(root, candidate);
		expect(validated.validation.ok).toBe(true);
	});

	test("blocks generated targets during validation", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-generated-"));
		tempRoots.push(root);
		await Bun.write(join(root, "bun.lock"), "lock");

		const canonical = canonicalizeParsedEdits([
			{
				sourceFormat: "structured",
				path: "bun.lock",
				operation: "update",
				replacement: "next",
				rawText: "raw",
			},
		]);
		const candidate = canonical.candidates[0];
		expect(candidate).toBeDefined();
		if (!candidate) {
			throw new Error("expected canonical candidate");
		}
		const validated = await validatePatchCandidate(root, candidate);
		expect(validated.validation.ok).toBe(false);
		if (!validated.validation.ok) {
			expect(validated.validation.reason).toBe("generated-target");
		}
	});

	test("enforces retry guard cooldown and recursion prevention", () => {
		const guards = createRetryGuardManager();
		const key = guards.buildKey(["same", "failure"]);

		const first = guards.start({
			dedupeKey: key,
			maxAttempts: 2,
			cooldownMs: 100,
			recursionGuard: true,
			now: 0,
		});
		expect(first.allowed).toBe(true);

		const recursive = guards.start({
			dedupeKey: key,
			maxAttempts: 2,
			cooldownMs: 100,
			recursionGuard: true,
			now: 1,
		});
		expect(recursive.allowed).toBe(false);
		expect(recursive.suppressionReason).toBe("recursion-guard");

		guards.finish(key, 10);
		const cooldown = guards.start({
			dedupeKey: key,
			maxAttempts: 2,
			cooldownMs: 100,
			recursionGuard: true,
			now: 20,
		});
		expect(cooldown.allowed).toBe(false);
		expect(cooldown.suppressionReason).toBe("cooldown-active");
	});

	test("extracts prompt hints for compiler mode", () => {
		const hints = extractPromptHints({
			promptText:
				"Fix AuthService in src/auth.ts and verify createSession handles session_token correctly",
		});

		expect(hints.paths).toContain("src/auth.ts");
		expect(hints.searchTerms).toContain("authservice");
		expect(hints.symbols).toContain("AuthService");
	});

	test("classifies terse incoming prompts for compilation", () => {
		const decision = classifyIncomingPrompt({
			parts: [{ type: "text", text: "opx fix src/auth.ts" }],
		});

		expect(decision.action).toBe("compile");
		expect(decision.reason).toBe("terse-prompt");
		expect(decision.promptText).toBe("fix src/auth.ts");
	});

	test("classifies quoted opx prompts for compilation", () => {
		const decision = classifyIncomingPrompt({
			parts: [{ type: "text", text: '"opx fix src/auth.ts"' }],
		});

		expect(decision.action).toBe("compile");
		expect(decision.reason).toBe("terse-prompt");
		expect(decision.promptText).toBe("fix src/auth.ts");
	});

	test("classifies trailing opx prompts for compilation", () => {
		const decision = classifyIncomingPrompt({
			parts: [{ type: "text", text: "fix src/auth.ts opx" }],
		});

		expect(decision.action).toBe("compile");
		expect(decision.reason).toBe("terse-prompt");
		expect(decision.promptText).toBe("fix src/auth.ts");
	});

	test("classifies quoted trailing opx prompts for compilation", () => {
		const decision = classifyIncomingPrompt({
			parts: [{ type: "text", text: '"fix src/auth.ts opx"' }],
		});

		expect(decision.action).toBe("compile");
		expect(decision.reason).toBe("terse-prompt");
		expect(decision.promptText).toBe("fix src/auth.ts");
	});

	test("parses trailing command opx suffix", () => {
		const decision = parseCommandTriggerArgs("fix src/auth.ts opx", "opx");

		expect(decision.opxEnabled).toBe(true);
		expect(decision.rawArgs).toBe("fix src/auth.ts opx");
		expect(decision.sanitizedArgs).toBe("fix src/auth.ts");
	});

	test("parses marker-only command suffix", () => {
		const decision = parseCommandTriggerArgs("opx", "opx");

		expect(decision.opxEnabled).toBe(true);
		expect(decision.sanitizedArgs).toBe("");
	});

	test("does not treat leading or flag-style command markers as suffixes", () => {
		expect(parseCommandTriggerArgs("opx fix src/auth.ts", "opx")).toEqual({
			rawArgs: "opx fix src/auth.ts",
			sanitizedArgs: "opx fix src/auth.ts",
			opxEnabled: false,
		});
		expect(parseCommandTriggerArgs("fix src/auth.ts --opx", "opx")).toEqual({
			rawArgs: "fix src/auth.ts --opx",
			sanitizedArgs: "fix src/auth.ts --opx",
			opxEnabled: false,
		});
	});

	test("passes through unmarked task prompts", () => {
		const decision = classifyIncomingPrompt({
			parts: [{ type: "text", text: "fix src/auth.ts" }],
		});

		expect(decision.action).toBe("pass-through");
		expect(decision.reason).toBe("no-trigger-marker");
	});

	test("passes through structured incoming prompts", () => {
		const decision = classifyIncomingPrompt({
			parts: [
				{
					type: "text",
					text: "opx ## Goal\n- update auth flow\n- run tests\n<output_contract>",
				},
			],
		});

		expect(decision.action).toBe("pass-through");
		expect(decision.reason).toBe("already-structured");
	});

	test("passes through casual incoming prompts", () => {
		const decision = classifyIncomingPrompt({
			parts: [{ type: "text", text: "opx hi" }],
		});

		expect(decision.action).toBe("pass-through");
		expect(decision.reason).toBe("casual-prompt");
		expect(decision.promptText).toBe("hi");
	});

	test("extracts prompt text from text parts only", () => {
		const text = extractPromptText([
			{ type: "text", text: "first" },
			{ type: "tool-call" },
			{ type: "text", text: "second" },
		]);

		expect(text).toBe("first\nsecond");
	});

	test("builds compiler context plan with snapshot and code-map notes", () => {
		const trigger = createRetryTrigger({
			source: "tool",
			type: "narrow-context-miss",
			failureMessage: "response ignored local auth context",
			attempt: 1,
			maxAttempts: 1,
			dedupeKey: "k1",
			path: "src/auth.ts",
		});

		const plan = buildCompilerContextPlan({
			trigger,
			taskClass: "implementation",
			promptText: "Update AuthService in src/auth.ts to validate session_token",
			failureSummary: "retry with grounded auth context",
			evidencePaths: ["src/auth.ts"],
			failurePaths: ["src/auth.ts"],
			snapshot: {
				workspaceRoot: "/tmp/project",
				branch: "main",
				trackedFiles: ["src/auth.ts", "src/session.ts"],
				tree: [{ path: "src", fileCount: 2, samples: ["src/auth.ts"] }],
				diff: [
					{
						path: "src/auth.ts",
						status: "modified",
						additions: 3,
						deletions: 1,
						staged: false,
					},
				],
				generatedAt: new Date().toISOString(),
			},
			codeMap: {
				branch: "main",
				usedCodeIntel: false,
				generatedAt: new Date().toISOString(),
				files: [
					{
						path: "src/auth.ts",
						imports: [],
						exports: ["AuthService"],
						symbols: ["AuthService", "createSession"],
						importanceScore: 5,
						provenance: "local",
					},
				],
			},
		});

		expect(plan.requests.some((request) => request.kind === "symbol")).toBe(
			true,
		);
		expect(
			plan.contextSlices.some((slice) => slice.provenance === "repo-snapshot"),
		).toBe(true);
		expect(
			plan.contextSlices.some((slice) => slice.provenance === "code-map"),
		).toBe(true);
		expect(plan.omissionReasons).toContain(
			"diagnostics-unavailable:no-line-aware-diagnostics-adapter",
		);
	});

	test("builds compiler prompt with GPT-5.4 contracts and omissions", () => {
		const prompt = buildCompilerPrompt({
			originalPrompt: "fix login bug",
			taskSummary: "Fix login bug in auth flow",
			failureSummary: "first retry lacked local auth context",
			taskClass: "debug",
			bundle: {
				bundleId: "b1",
				createdAt: new Date().toISOString(),
				taskSummary: "Fix login bug in auth flow",
				failureSummary: "first retry lacked local auth context",
				tokenBudget: 1000,
				includedTokens: 20,
				omittedReasons: [],
				provenance: ["src/auth.ts:1-10"],
				evidenceSlices: [
					{
						id: "s1",
						kind: "file-slice",
						path: "src/auth.ts",
						reason: "failure path",
						excerpt: "10: export function login() {}",
						tokenCount: 5,
						provenance: "src/auth.ts:10-10",
						redacted: false,
					},
				],
			},
			decision: {
				action: "retry-helper",
				reason: "grounded-evidence-present",
				trigger: createRetryTrigger({
					source: "tool",
					type: "narrow-context-miss",
					failureMessage: "need more context",
					attempt: 1,
					maxAttempts: 1,
					dedupeKey: "k2",
				}),
				oracleRequired: false,
				taskClass: "debug",
			},
			successCriteria: ["Verify login succeeds", "Run relevant tests"],
			omissionReasons: [
				"diagnostics-unavailable:no-line-aware-diagnostics-adapter",
			],
		});

		expect(prompt).toContain("<output_contract>");
		expect(prompt).toContain("<verification_loop>");
		expect(prompt).toContain("<grounding_context>");
		expect(prompt).toContain("<missing_context>");
		expect(prompt).toContain("Verify login succeeds");
	});

	test("builds plan compiler prompt with confirmation and blast-radius guidance", () => {
		const prompt = buildCompilerPrompt({
			originalPrompt: "plan the rollout for refinement-first planning",
			taskSummary: "Create a refinement-first planning workflow",
			failureSummary: "the first draft skipped confirmation gates",
			taskClass: "plan",
			bundle: {
				bundleId: "b2",
				createdAt: new Date().toISOString(),
				taskSummary: "Create a refinement-first planning workflow",
				failureSummary: "the first draft skipped confirmation gates",
				tokenBudget: 1000,
				includedTokens: 20,
				omittedReasons: [],
				provenance: ["packages/install/templates/agents/plan.md:1-20"],
				evidenceSlices: [
					{
						id: "s2",
						kind: "file-slice",
						path: "packages/install/templates/agents/plan.md",
						reason: "planner prompt",
						excerpt: "8: # Plan Agent",
						tokenCount: 5,
						provenance: "packages/install/templates/agents/plan.md:8-8",
						redacted: false,
					},
				],
			},
			decision: {
				action: "retry-helper",
				reason: "grounded-evidence-present",
				trigger: createRetryTrigger({
					source: "tool",
					type: "manual-helper-request",
					failureMessage: "need a stronger planning brief",
					attempt: 1,
					maxAttempts: 1,
					dedupeKey: "k3",
				}),
				oracleRequired: false,
				taskClass: "plan",
			},
		});

		expect(prompt).toContain("<confirmation_gates>");
		expect(prompt).toContain("blast radius");
		expect(prompt).toContain("Save a draft before promotion");
	});
});
