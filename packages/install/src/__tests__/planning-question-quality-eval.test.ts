import { describe, expect, test } from "bun:test";
import { join } from "node:path";

interface PlanningQuestionQualityEvalCase {
	id: string;
	prompt: string;
	expected_mode: "repo-pattern" | "best-practice";
	must_capture_branches?: string[];
	must_surface_files?: string[];
	must_do_bounded_research?: boolean;
	must_ask: string;
	must_persist: string[];
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
		expect(content).toContain("execution_clarification_load");
		expect(content).toContain("one question at a time");
		expect(content).toContain("missing-context behavior");
		expect(content).toContain("state ownership");
		expect(content).toContain("interview_quality");
		expect(content).toContain("before");
		expect(content).toContain("after");
	});

	test("covers repo-pattern, frontend-routing, and best-practice fallback cases", async () => {
		const raw = await Bun.file(evalCasesPath).text();
		const cases = JSON.parse(raw) as PlanningQuestionQualityEvalCase[];

		expect(cases).toHaveLength(3);

		const repoPattern = cases.find((item) => item.id === "repo-pattern-follow");
		expect(repoPattern).toBeDefined();
		expect(repoPattern?.expected_mode).toBe("repo-pattern");
		expect(repoPattern?.must_ask).toBe("Follow existing pattern?");
		expect(repoPattern?.must_surface_files).toContain(
			"packages/workspace/src/index.ts",
		);
		expect(repoPattern?.must_surface_files).toContain(
			"packages/workspace/src/plan/state.ts",
		);
		expect(repoPattern?.must_capture_branches).toContain(
			"missing-context behavior",
		);
		expect(repoPattern?.must_capture_branches).toContain("approval/readiness");
		expect(repoPattern?.must_capture_branches).toContain("triggers");
		expect(repoPattern?.must_capture_branches).toContain("rules");
		expect(repoPattern?.must_persist).toContain("source_type: repo");
		expect(repoPattern?.must_persist).toContain("code_example");
		expect(repoPattern?.max_execution_follow_up_questions).toBe(0);

		const fallback = cases.find((item) => item.id === "best-practice-fallback");
		expect(fallback).toBeDefined();
		expect(fallback?.expected_mode).toBe("best-practice");
		expect(fallback?.must_do_bounded_research).toBe(true);
		expect(fallback?.must_capture_branches).toContain("state ownership");
		expect(fallback?.must_capture_branches).toContain("triggers");
		expect(fallback?.must_capture_branches).toContain("rules");
		expect(fallback?.must_capture_branches).toContain("tests");
		expect(fallback?.must_ask).toBe("Approve recommended fallback?");
		expect(fallback?.must_persist).toContain("source_type: best-practice");
		expect(fallback?.must_persist).toContain("code_example");
		expect(fallback?.max_execution_follow_up_questions).toBe(1);

		const frontendOwnership = cases.find(
			(item) => item.id === "frontend-ownership-reroute",
		);
		expect(frontendOwnership).toBeDefined();
		expect(frontendOwnership?.expected_mode).toBe("repo-pattern");
		expect(frontendOwnership?.must_ask).toBe("Follow existing pattern?");
		expect(frontendOwnership?.must_surface_files).toContain(
			"packages/install/templates/agents/build.md",
		);
		expect(frontendOwnership?.must_surface_files).toContain(
			"packages/workspace/src/delegation/router.ts",
		);
		expect(frontendOwnership?.must_capture_branches).toContain(
			"state ownership",
		);
		expect(frontendOwnership?.must_capture_branches).toContain("triggers");
		expect(frontendOwnership?.must_capture_branches).toContain("rules");
		expect(frontendOwnership?.must_capture_branches).toContain("tests");
		expect(frontendOwnership?.must_persist).toContain("source_type: repo");
		expect(frontendOwnership?.must_persist).toContain("code_example");
		expect(frontendOwnership?.must_persist).toContain(
			"frontend ownership routing",
		);
		expect(frontendOwnership?.max_execution_follow_up_questions).toBe(0);
	});
});
