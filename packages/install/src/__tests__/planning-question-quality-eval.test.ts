import { describe, expect, test } from "bun:test";
import { join } from "node:path";

interface PlanningQuestionQualityEvalCase {
	id: string;
	prompt: string;
	expected_mode: "repo-pattern" | "best-practice";
	expected_primary_kind:
		| "implementation"
		| "prd"
		| "refactor"
		| "interface"
		| "tdd";
	expected_overlays?: string[];
	must_capture_branches?: string[];
	must_surface_files?: string[];
	must_do_bounded_research?: boolean;
	must_use_grill_me?: boolean;
	must_confirm_non_default_patterns?: boolean;
	must_ask: string;
	must_persist: string[];
	must_not_reask_in_work?: boolean;
	max_execution_follow_up_questions: number;
}

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const evalDocPath = join(
	repoRoot,
	"docs",
	"evaluations",
	"planning-question-quality.md",
);
const evalCasesPath = join(
	repoRoot,
	"docs",
	"evaluations",
	"planning-question-quality-cases.json",
);

describe("planning question quality evaluation", () => {
	test("documents the persisted approval contract", async () => {
		const content = await Bun.file(evalDocPath).text();

		expect(content).toContain("source_type");
		expect(content).toContain("code_example");
		expect(content).toContain("file change map");
		expect(content).toContain("grill-me");
		expect(content).toContain("forward-facing");
		expect(content).toContain(
			"asked enough important questions before saving instead of stopping after one thin question",
		);
		expect(content).toContain(
			"fallback or non-obvious pattern choices got explicit human confirmation",
		);
		expect(content).toContain("native `question` tool");
		expect(content).toContain("primary_kind");
		expect(content).toContain("overlays");
		expect(content).toContain("deep_grill_quality");
		expect(content).toContain("question_quality");
		expect(content).toContain("plan_specificity");
		expect(content).toContain("handoff_reuse");
		expect(content).toContain("execution_clarification_load");
		expect(content).not.toContain("one question at a time");
		expect(content).toContain("missing-context behavior");
		expect(content).toContain("dependencies");
		expect(content).toContain("state ownership");
		expect(content).toContain("overlay_activation");
		expect(content).toContain("before");
		expect(content).toContain("after");
		expect(content).not.toContain("3-7 questions");
	});

	test("covers adaptive primary-kind and overlay planning cases", async () => {
		const raw = await Bun.file(evalCasesPath).text();
		const cases = JSON.parse(raw) as PlanningQuestionQualityEvalCase[];

		expect(cases).toHaveLength(7);

		const repoPattern = cases.find((item) => item.id === "repo-pattern-follow");
		expect(repoPattern).toBeDefined();
		expect(repoPattern?.expected_mode).toBe("repo-pattern");
		expect(repoPattern?.expected_primary_kind).toBe("implementation");
		expect(repoPattern?.expected_overlays).toContain("deep-grill");
		expect(repoPattern?.must_ask).toContain("blast radius");
		expect(repoPattern?.must_surface_files).toContain(
			"packages/workspace/src/index.ts",
		);
		expect(repoPattern?.must_surface_files).toContain(
			"packages/workspace/src/plan/state.ts",
		);
		expect(repoPattern?.must_capture_branches).toContain(
			"missing_context_behavior",
		);
		expect(repoPattern?.must_capture_branches).toContain(
			"approval_readiness_rules",
		);
		expect(repoPattern?.must_capture_branches).toContain("dependencies");
		expect(repoPattern?.must_capture_branches).toContain("triggers");
		expect(repoPattern?.must_capture_branches).toContain("invariants");
		expect(repoPattern?.must_use_grill_me).toBe(true);
		expect(repoPattern?.must_confirm_non_default_patterns).toBe(false);
		expect(repoPattern?.must_persist).toContain("primary_kind: implementation");
		expect(repoPattern?.must_persist).toContain("overlays: deep-grill");
		expect(repoPattern?.must_persist).toContain("source_type: repo");
		expect(repoPattern?.must_persist).toContain("code_example");
		expect(repoPattern?.must_persist).toContain("file_change_map_json");
		expect(repoPattern?.must_not_reask_in_work).toBe(true);
		expect(repoPattern?.max_execution_follow_up_questions).toBe(0);

		const fallback = cases.find((item) => item.id === "best-practice-fallback");
		expect(fallback).toBeDefined();
		expect(fallback?.expected_mode).toBe("best-practice");
		expect(fallback?.expected_primary_kind).toBe("implementation");
		expect(fallback?.expected_overlays).toContain("deep-grill");
		expect(fallback?.must_do_bounded_research).toBe(true);
		expect(fallback?.must_capture_branches).toContain("state_ownership");
		expect(fallback?.must_capture_branches).toContain("dependencies");
		expect(fallback?.must_capture_branches).toContain("triggers");
		expect(fallback?.must_capture_branches).toContain("invariants");
		expect(fallback?.must_capture_branches).toContain("tests");
		expect(fallback?.must_use_grill_me).toBe(true);
		expect(fallback?.must_confirm_non_default_patterns).toBe(true);
		expect(fallback?.must_ask).toContain("fallback");
		expect(fallback?.must_persist).toContain("primary_kind: implementation");
		expect(fallback?.must_persist).toContain("overlays: deep-grill");
		expect(fallback?.must_persist).toContain("source_type: best-practice");
		expect(fallback?.must_persist).toContain("code_example");
		expect(fallback?.must_persist).toContain("file_change_map_json");
		expect(fallback?.must_not_reask_in_work).toBe(true);
		expect(fallback?.max_execution_follow_up_questions).toBe(0);

		const prdCase = cases.find((item) => item.id === "prd-vertical-slices");
		expect(prdCase).toBeDefined();
		expect(prdCase?.expected_primary_kind).toBe("prd");
		expect(prdCase?.expected_overlays).toEqual(
			expect.arrayContaining([
				"deep-grill",
				"user-story-mapping",
				"vertical-slices",
			]),
		);
		expect(prdCase?.must_capture_branches).toContain(
			"missing_context_behavior",
		);
		expect(prdCase?.must_capture_branches).toContain("state_ownership");
		expect(prdCase?.must_capture_branches).toContain("triggers");
		expect(prdCase?.must_capture_branches).toContain("invariants");
		expect(prdCase?.must_use_grill_me).toBe(true);
		expect(prdCase?.must_confirm_non_default_patterns).toBe(true);
		expect(prdCase?.must_ask).toContain("fallback");
		expect(prdCase?.must_persist).toContain("primary_kind: prd");
		expect(prdCase?.must_persist).toContain("source_type: best-practice");
		expect(prdCase?.must_persist).toContain("file_change_map_json");
		expect(prdCase?.must_not_reask_in_work).toBe(true);

		const refactorCase = cases.find(
			(item) => item.id === "refactor-small-commits",
		);
		expect(refactorCase).toBeDefined();
		expect(refactorCase?.expected_primary_kind).toBe("refactor");
		expect(refactorCase?.expected_overlays).toEqual(
			expect.arrayContaining(["refactor-sequencing", "dependency-modeling"]),
		);
		expect(refactorCase?.must_ask).toContain("sequencing");
		expect(refactorCase?.must_capture_branches).toContain(
			"missing_context_behavior",
		);
		expect(refactorCase?.must_capture_branches).toContain(
			"approval_readiness_rules",
		);
		expect(refactorCase?.must_capture_branches).toContain("dependencies");
		expect(refactorCase?.must_use_grill_me).toBe(true);
		expect(refactorCase?.must_confirm_non_default_patterns).toBe(false);
		expect(refactorCase?.must_persist).toContain(
			"overlays: refactor-sequencing",
		);
		expect(refactorCase?.must_persist).toContain("file_change_map_json");

		const interfaceCase = cases.find(
			(item) => item.id === "interface-comparison",
		);
		expect(interfaceCase).toBeDefined();
		expect(interfaceCase?.expected_primary_kind).toBe("interface");
		expect(interfaceCase?.expected_overlays).toContain("interface-review");
		expect(interfaceCase?.must_capture_branches).toContain(
			"missing_context_behavior",
		);
		expect(interfaceCase?.must_capture_branches).toContain("state_ownership");
		expect(interfaceCase?.must_capture_branches).toContain("triggers");
		expect(interfaceCase?.must_capture_branches).toContain("invariants");
		expect(interfaceCase?.must_use_grill_me).toBe(true);
		expect(interfaceCase?.must_confirm_non_default_patterns).toBe(true);
		expect(interfaceCase?.must_ask).toContain("fallback");
		expect(interfaceCase?.must_persist).toContain(
			"source_type: best-practice",
		);
		expect(interfaceCase?.must_persist).toContain("file_change_map_json");

		const tddCase = cases.find((item) => item.id === "tdd-planning");
		expect(tddCase).toBeDefined();
		expect(tddCase?.expected_primary_kind).toBe("tdd");
		expect(tddCase?.expected_overlays).toEqual(
			expect.arrayContaining(["deep-grill", "tdd"]),
		);
		expect(tddCase?.must_ask).toContain("readiness");
		expect(tddCase?.must_capture_branches).toContain("non_goals");
		expect(tddCase?.must_capture_branches).toContain(
			"missing_context_behavior",
		);
		expect(tddCase?.must_capture_branches).toContain("state_ownership");
		expect(tddCase?.must_capture_branches).toContain("triggers");
		expect(tddCase?.must_capture_branches).toContain("invariants");
		expect(tddCase?.must_use_grill_me).toBe(true);
		expect(tddCase?.must_confirm_non_default_patterns).toBe(false);
		expect(tddCase?.must_persist).toContain("file_change_map_json");

		const mixedCase = cases.find(
			(item) => item.id === "mixed-overlay-no-reask",
		);
		expect(mixedCase).toBeDefined();
		expect(mixedCase?.expected_primary_kind).toBe("implementation");
		expect(mixedCase?.expected_overlays).toEqual(
			expect.arrayContaining([
				"deep-grill",
				"refactor-sequencing",
				"tdd",
				"dependency-modeling",
			]),
		);
		expect(mixedCase?.must_surface_files).toContain(
			"packages/install/templates/commands/work.md",
		);
		expect(mixedCase?.must_surface_files).toContain(
			"packages/delegation/src/index.ts",
		);
		expect(mixedCase?.must_ask).toContain("ownership");
		expect(mixedCase?.must_use_grill_me).toBe(true);
		expect(mixedCase?.must_confirm_non_default_patterns).toBe(false);
		expect(mixedCase?.must_not_reask_in_work).toBe(true);
		expect(mixedCase?.must_persist).toContain("source_type: repo");
		expect(mixedCase?.must_persist).toContain("file_change_map_json");
		expect(mixedCase?.max_execution_follow_up_questions).toBe(0);
	});
});
