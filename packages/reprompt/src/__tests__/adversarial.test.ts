import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetryTrigger } from "../orchestration/triggers.js";
import { canonicalizeParsedEdits } from "../patching/canonicalize.js";
import { validatePatchCandidate } from "../patching/validate.js";
import { resolveOraclePolicy } from "../selection/oracle-policy.js";
import { packEvidenceSlices } from "../serializer/compress.js";
import { collectRepoSnapshot } from "../serializer/repo-snapshot.js";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots.length = 0;
});

describe("reprompt adversarial cases", () => {
	test("repo snapshot falls back cleanly without git metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-nogit-"));
		tempRoots.push(root);
		await Bun.write(join(root, "file.ts"), "export const x = 1\n");

		const snapshot = await collectRepoSnapshot(root);
		expect(snapshot.branch).toBe(null);
		expect(snapshot.trackedFiles).toContain("file.ts");
	});

	test("packing omits slices when token budget is too small", () => {
		const packed = packEvidenceSlices({
			taskSummary: "fix large bundle",
			failureSummary: "too much evidence",
			slices: [
				{
					id: "1",
					kind: "file-slice",
					path: "a.ts",
					reason: "first",
					excerpt: "a".repeat(500),
					tokenCount: 130,
					provenance: "a.ts:1-20",
					redacted: false,
				},
				{
					id: "2",
					kind: "file-slice",
					path: "b.ts",
					reason: "second",
					excerpt: "short",
					tokenCount: 2,
					provenance: "b.ts:1-1",
					redacted: false,
				},
			],
			budget: { maxTokens: 10, maxBytes: 50, maxSlices: 2 },
		});

		expect(packed.evidenceSlices).toHaveLength(1);
		expect(packed.evidenceSlices[0]?.path).toBe("b.ts");
		expect(
			packed.omittedReasons.some((item) => item.startsWith("budget:")),
		).toBe(true);
	});

	test("oracle policy blocks escalation loops after call cap", () => {
		const trigger = createRetryTrigger({
			source: "tool",
			type: "narrow-context-miss",
			failureMessage: "need more context",
			attempt: 2,
			maxAttempts: 3,
			dedupeKey: "abc",
		});
		const decision = resolveOraclePolicy({
			mode: "allow",
			maxBundleTokens: 2000,
			maxCallsPerSession: 1,
			sessionOracleCalls: 1,
			oracleAvailable: true,
			confidence: 0.1,
			includedTokens: 500,
			trigger,
		});

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("oracle-call-cap");
	});

	test("validation fails when repo state is stale and anchor text disappears", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-stale-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "alpha\nomega\n");

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
		expect(validated.validation.ok).toBe(false);
		if (!validated.validation.ok) {
			expect(validated.validation.reason).toBe("ambiguous-anchor");
		}
	});

	test("validation rejects binary targets explicitly", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-binary-"));
		tempRoots.push(root);
		await Bun.write(join(root, "image.png"), new Uint8Array([1, 2, 3]));

		const canonical = canonicalizeParsedEdits([
			{
				sourceFormat: "structured",
				path: "image.png",
				operation: "update",
				replacement: "text",
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
			expect(validated.validation.reason).toBe("binary-target");
		}
	});
});
