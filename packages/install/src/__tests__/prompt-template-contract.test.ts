import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const templatesDir = join(import.meta.dir, "..", "..", "templates");

async function readTemplate(...parts: string[]): Promise<string> {
	return Bun.file(join(templatesDir, ...parts)).text();
}

async function pathExists(...parts: string[]): Promise<boolean> {
	try {
		await stat(join(templatesDir, ...parts));
		return true;
	} catch {
		return false;
	}
}

describe("prompt template contracts", () => {
	test("build agent includes the shared GPT-5.4 execution contract", async () => {
		const prompt = await readTemplate("agents", "build.md");

		for (const tag of [
			"output_contract",
			"default_follow_through_policy",
			"tool_persistence_rules",
			"dependency_checks",
			"completeness_contract",
			"current_state_default",
			"verification_loop",
			"terminal_tool_hygiene",
			"user_updates_spec",
		]) {
			expect(prompt).toContain(`<${tag}>`);
		}

		expect(prompt).toContain("small, actionable, reversible work");
		expect(prompt).toContain(
			"fail closed and tell the user to run `/plan` or provide a concrete task",
		);
		expect(prompt).not.toContain("/autoloop");
		expect(prompt).not.toContain("/continue");
		expect(prompt).toContain(
			"compatibility shims, adapters, fallback branches",
		);
	});

	test("plan agent defers schema details to plan-protocol", async () => {
		const prompt = await readTemplate("agents", "plan.md");

		expect(prompt).toContain('skill("plan-protocol")');
		expect(prompt).toContain("question");
		expect(prompt).toContain("Oracle");
		expect(prompt).toContain("plan_context_write");
		expect(prompt).toContain('plan_save(mode="new", set_active=true)');
		expect(prompt).toContain("bounded pattern-scout pass");
		expect(prompt).toContain("follow existing pattern?");
		expect(prompt).toContain("code_example");
		expect(prompt).toContain("one question at a time");
		expect(prompt).toContain("missing-context behavior");
		expect(prompt).toContain("planning-question-quality evaluation artifact");
		expect(prompt).not.toContain("plan_promote");
		expect(prompt).not.toContain("Use this exact structure:");
	});

	test("reviewer agent defers detailed rubric text to code-review", async () => {
		const prompt = await readTemplate("agents", "reviewer.md");

		expect(prompt).toContain("code-review");
		expect(prompt).not.toContain("## The 4 Review Layers");
		expect(prompt).not.toContain("## Severity Classification");
	});

	test("researcher agent uses current research tools instead of stale ZAI docs tooling", async () => {
		const prompt = await readTemplate("agents", "researcher.md");

		expect(prompt).toContain("context7_resolve-library-id");
		expect(prompt).toContain("context7_query-docs");
		expect(prompt).toContain("grep_app_searchGitHub");
		expect(prompt).toContain("webfetch");
		expect(prompt).not.toContain("zai-zread");
		expect(prompt).not.toContain("zai-search");
	});

	test("key commands preload skills and avoid duplicated autonomy policy text", async () => {
		const planCommand = await readTemplate("commands", "plan.md");
		const reviewCommand = await readTemplate("commands", "review.md");
		const workCommand = await readTemplate("commands", "work.md");
		const deslopCommand = await readTemplate("commands", "deslop.md");

		expect(planCommand).toContain("plan-protocol");
		expect(planCommand).toContain("plan_context_write");
		expect(planCommand).toContain('plan_save(mode="new", set_active=true)');
		expect(planCommand).toContain("bounded internal pattern-scout pass");
		expect(planCommand).toContain("follow existing pattern?");
		expect(planCommand).toContain("source_type");
		expect(planCommand).toContain("one question at a time");
		expect(planCommand).toContain("state ownership");
		expect(planCommand).toContain("Do not save any plan until");
		expect(planCommand).toContain(
			"planning-question-quality evaluation artifact",
		);
		expect(reviewCommand).toContain("code-review");
		expect(workCommand).toContain("plan_context_read");
		expect(workCommand).toContain("approved implementation reference");
		expect(workCommand).toContain("/work` is the sole execution path");
		expect(workCommand).toContain("small actionable task");
		expect(workCommand).toContain("run `/plan` or provide a concrete task");
		expect(workCommand).not.toContain('Do NOT say "I can continue"');
		expect(workCommand).not.toContain("plan_promote");
		expect(workCommand).not.toContain("/continue");
		expect(workCommand).not.toContain("/autoloop");
		expect(deslopCommand).toContain("analyze-mode");
		expect(deslopCommand).toContain("simplify");
		expect(deslopCommand).toContain("code-philosophy");
		expect(deslopCommand).toContain("<output_contract>");
		expect(deslopCommand).toContain("resolved base branch or fallback basis");
		expect(deslopCommand).not.toContain("origin/main");
	});

	test("legacy continue and autoloop commands are removed from shipped templates", async () => {
		expect(await pathExists("commands", "continue.md")).toBe(false);
		expect(await pathExists("commands", "autoloop.md")).toBe(false);
	});

	test("simplify keeps reusable no-compat rules in a skill", async () => {
		const prompt = await readTemplate("skills", "simplify", "SKILL.md");

		expect(prompt).toContain("name: simplify");
		expect(prompt).toContain(
			"Prefer one current path over dual-path compatibility scaffolding.",
		);
		expect(prompt).toContain(
			"Keep compatibility glue only when at least one is true:",
		);
		expect(prompt).toContain("exact deletion criteria");
		expect(prompt).toContain(
			"Prefer fail-fast diagnostics and explicit recovery steps over silent fallback behavior.",
		);
	});

	test("ulw defers detailed proof mechanics to verification-before-completion", async () => {
		const ulw = await readTemplate("skills", "ulw", "SKILL.md");
		const verification = await readTemplate(
			"skills",
			"verification-before-completion",
			"SKILL.md",
		);

		expect(ulw).toContain("verification-before-completion");
		expect(ulw).not.toContain("## Verification Guarantee (NON-NEGOTIABLE)");
		expect(verification).toContain("## Evidence Format");
	});

	test("long-running workflows skill defines durable state and pause controls", async () => {
		const prompt = await readTemplate(
			"skills",
			"long-running-workflows",
			"SKILL.md",
		);

		expect(prompt).toContain("name: long-running-workflows");
		expect(prompt).toContain(".opencode/workspace/autoloop/<slug>/");
		expect(prompt).toContain("state.jsonl");
		expect(prompt).toContain(".paused");
		expect(prompt).toContain("dedicated autoloop plan");
		expect(prompt).toContain("continuation_status");
		expect(prompt).toContain("continuation_stop");
		expect(prompt).toContain(
			"Do not create git commits unless the user explicitly asks for them.",
		);
		expect(prompt).toContain(
			"Do not pause just to present a menu of safe recovery options",
		);
		expect(prompt).toContain("## Autonomous Recovery");
	});

	test("context engineering documents context-scout and linked plan docs", async () => {
		const prompt = await readTemplate(
			"skills",
			"context-engineering",
			"SKILL.md",
		);

		expect(prompt).toContain("[context-scout]");
		expect(prompt).toContain("Linked plan docs");
	});

	test("skill catalog removes legacy singular tree and empty skill directories", async () => {
		const singularExists = await pathExists("skill");
		expect(singularExists).toBe(false);

		const skillEntries = await readdir(join(templatesDir, "skills"), {
			withFileTypes: true,
		});

		const skillDirs = skillEntries.filter(
			(entry) => entry.isDirectory() && !entry.name.startsWith("."),
		);

		for (const dir of skillDirs) {
			const hasSkill = await pathExists("skills", dir.name, "SKILL.md");
			expect(hasSkill).toBe(true);
		}
	});

	test("agent-browser skill replaces chrome-devtools", async () => {
		const agentBrowser = await readTemplate(
			"skills",
			"agent-browser",
			"SKILL.md",
		);

		expect(agentBrowser).toContain("name: agent-browser");
		expect(agentBrowser).toContain("Bash(agent-browser:*)");
		expect(agentBrowser).toContain("snapshot -i");
		expect(agentBrowser).toContain("auth login");

		const chromeDevtoolsExists = await pathExists(
			"skills",
			"chrome-devtools",
			"SKILL.md",
		);
		expect(chromeDevtoolsExists).toBe(false);
	});

	test("agent-browser skill ships all referenced support assets", async () => {
		const prompt = await readTemplate("skills", "agent-browser", "SKILL.md");
		const referencedAssets = [
			...prompt.matchAll(/\((references\/[^)]+|templates\/[^)]+)\)/g),
		].map((match) => match[1]);

		expect(referencedAssets.length).toBeGreaterThan(0);

		for (const relativePath of new Set(referencedAssets)) {
			const exists = await pathExists(
				"skills",
				"agent-browser",
				...relativePath.split("/"),
			);
			expect(exists).toBe(true);
		}
	});

	test("shadcn guidance prefers installed official skill before MCP and CLI fallback", async () => {
		const [coder, frontend, researcher] = await Promise.all([
			readTemplate("agents", "coder.md"),
			readTemplate("agents", "frontend.md"),
			readTemplate("agents", "researcher.md"),
		]);

		for (const prompt of [coder, frontend, researcher]) {
			expect(prompt).toContain(".agents/skills/");
			expect(prompt).toContain("~/.config/opencode/skills/");
			expect(prompt).toContain("components.json");
			expect(prompt).toContain("mcp0");
			expect(prompt).toContain("shadcn@latest info --json");
		}

		const vendoredShadcnSkillExists = await pathExists(
			"skills",
			"shadcn-ui",
			"SKILL.md",
		);
		expect(vendoredShadcnSkillExists).toBe(false);
	});

	test("prompt taxonomy documents layer ownership and shared defaults", async () => {
		const prompt = await readTemplate("PROMPT_TAXONOMY.md");

		expect(prompt).toContain("## Layer Ownership");
		expect(prompt).toContain("## Shared GPT-5.4 Defaults");
		expect(prompt).toContain("## Hook Responsibilities");
	});
});
