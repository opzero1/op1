import { describe, expect, test } from "bun:test";
import {
	classifyDelegationCategory,
	parseDelegationCategory,
	resolveDelegationRouting,
} from "../delegation/router";

describe("delegation router", () => {
	test("preserves explicit subagent when auto-route is disabled", () => {
		const result = resolveDelegationRouting({
			description: "Quick fix",
			prompt: "Fix a small bug in parser",
			subagentType: "coder",
			autoRoute: false,
		});

		expect(result.agent).toBe("coder");
		expect(result.telemetry.fallback_path).toBe("user-subagent");
	});

	test("keeps explicit subagent override when auto-route is enabled", () => {
		const result = resolveDelegationRouting({
			description: "Research and implement",
			prompt: "Investigate docs and then implement a fix",
			subagentType: "reviewer",
			autoRoute: true,
		});

		expect(result.agent).toBe("reviewer");
		expect(result.telemetry.fallback_path).toBe("user-subagent");
	});

	test("routes by explicit category with category-default fallback path", () => {
		const result = resolveDelegationRouting({
			description: "Need architecture review",
			prompt: "Investigate architecture risk",
			category: "review",
			autoRoute: true,
		});

		expect(result.agent).toBe("reviewer");
		expect(result.telemetry.detected_category).toBe("review");
		expect(result.telemetry.fallback_path).toBe("category-default");
	});

	test("classifies research prompts using keyword routing", () => {
		const result = resolveDelegationRouting({
			description: "Research API behavior",
			prompt: "Investigate docs and compare library approaches",
			autoRoute: true,
		});

		expect(result.agent).toBe("researcher");
		expect(result.telemetry.detected_category).toBe("research");
		expect(result.telemetry.confidence).toBeGreaterThan(0.6);
	});

	test("falls back to general category when prompt is ambiguous", () => {
		const classification = classifyDelegationCategory("run thing");
		expect(classification.category).toBe("general");
		expect(classification.fallbackPath).toBe("keyword-fallback");
	});

	test("routes planning/build categories to supported agents", () => {
		const planning = resolveDelegationRouting({
			description: "Plan architecture",
			prompt: "Create a rollout strategy",
			category: "planning",
			autoRoute: true,
		});
		expect(planning.agent).toBe("oracle");

		const build = resolveDelegationRouting({
			description: "Implement feature",
			prompt: "Ship code for the API",
			category: "build",
			autoRoute: true,
		});
		expect(build.agent).toBe("coder");
	});

	test("maintains deterministic category for split-intent prompts", () => {
		const input = {
			description: "Research and review",
			prompt: "Research docs and review security findings",
			autoRoute: true,
		};

		const first = resolveDelegationRouting(input);
		const second = resolveDelegationRouting(input);
		expect(first.telemetry.detected_category).toBe(
			second.telemetry.detected_category,
		);
		expect(first.agent).toBe(second.agent);
	});

	test("meets golden routing accuracy threshold", () => {
		const golden: Array<{
			description: string;
			prompt: string;
			expectedCategory: string;
		}> = [
			{
				description: "Fix tiny typo",
				prompt: "small one-line update in docs",
				expectedCategory: "quick",
			},
			{
				description: "Investigate architecture",
				prompt: "debug complex system behavior",
				expectedCategory: "deep",
			},
			{
				description: "UI polish",
				prompt: "improve css layout and ux",
				expectedCategory: "visual",
			},
			{
				description: "Read docs",
				prompt: "research and compare api approaches",
				expectedCategory: "research",
			},
			{
				description: "Audit service",
				prompt: "review security and performance concerns",
				expectedCategory: "review",
			},
			{
				description: "Ship feature",
				prompt: "implement and refactor code path",
				expectedCategory: "build",
			},
			{
				description: "Phase strategy",
				prompt: "plan roadmap and approach",
				expectedCategory: "planning",
			},
			{
				description: "Unclear request",
				prompt: "do thing",
				expectedCategory: "general",
			},
			{
				description: "Frontend card",
				prompt: "design css component",
				expectedCategory: "visual",
			},
			{
				description: "Performance audit",
				prompt: "inspect performance bottlenecks",
				expectedCategory: "review",
			},
			{
				description: "Frontend polish",
				prompt: "frontend ui layout cleanup",
				expectedCategory: "visual",
			},
			{
				description: "Docs research",
				prompt: "research official docs and compare approaches",
				expectedCategory: "research",
			},
			{
				description: "Security review",
				prompt: "security audit for auth flow",
				expectedCategory: "review",
			},
			{
				description: "Phase roadmap",
				prompt: "create a phase by phase roadmap and strategy",
				expectedCategory: "planning",
			},
			{
				description: "Root cause hunt",
				prompt: "debug complex root cause in system",
				expectedCategory: "deep",
			},
			{
				description: "Tiny rename",
				prompt: "small minor one-line rename",
				expectedCategory: "quick",
			},
			{
				description: "Ship feature",
				prompt: "implement feature and refactor code path",
				expectedCategory: "build",
			},
			{
				description: "Investigate design system",
				prompt: "analyze design tokens and compare component ux",
				expectedCategory: "research",
			},
			{
				description: "Architecture review",
				prompt: "architecture strategy for complex service",
				expectedCategory: "deep",
			},
		];

		let exactMatches = 0;
		let fallbackCount = 0;
		for (const entry of golden) {
			const result = resolveDelegationRouting({
				description: entry.description,
				prompt: entry.prompt,
				autoRoute: true,
			});
			if (result.telemetry.detected_category === entry.expectedCategory) {
				exactMatches += 1;
			}
			if (result.telemetry.fallback_path !== "none") {
				fallbackCount += 1;
			}
		}

		const accuracy = exactMatches / golden.length;
		const fallbackRate = fallbackCount / golden.length;
		expect(accuracy).toBeGreaterThanOrEqual(0.9);
		expect(fallbackRate).toBeLessThanOrEqual(0.2);
	});

	test("parses only known category values", () => {
		expect(parseDelegationCategory("visual")).toBe("visual");
		expect(parseDelegationCategory("  planning  ")).toBe("planning");
		expect(parseDelegationCategory("unknown")).toBeNull();
	});
});
