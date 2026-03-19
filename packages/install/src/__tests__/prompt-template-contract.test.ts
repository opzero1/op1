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

		expect(prompt).toContain("If the request is `/autoloop`");
		expect(prompt).toContain("recover the autoloop state first");
		expect(prompt).toContain("autoloop_status");
		expect(prompt).toContain(
			"does not replace the dedicated autoloop plan as the lifecycle source of truth",
		);
		expect(prompt).toContain("do not adopt the current feature plan");
		expect(prompt).toContain(
			"do not drift into ordinary completion-report mode",
		);
		expect(prompt).toContain("make it a running-status note only");
		expect(prompt).toContain("prefer `autoloop_checkpoint`");
		expect(prompt).toContain("set `command` to `autoloop:<slug>`");
		expect(prompt).toContain("one slug and one git worktree per loop");
		expect(prompt).toContain("prefer `worktree_create`");
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
		expect(prompt).toContain("plan_promote");
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
		const autoloopCommand = await readTemplate("commands", "autoloop.md");
		const deslopCommand = await readTemplate("commands", "deslop.md");

		expect(planCommand).toContain("plan-protocol");
		expect(planCommand).toContain("plan_context_write");
		expect(planCommand).toContain("plan_promote");
		expect(reviewCommand).toContain("code-review");
		expect(workCommand).toContain("plan_context_read");
		expect(workCommand).not.toContain('Do NOT say "I can continue"');
		expect(autoloopCommand).toContain("plan-protocol");
		expect(autoloopCommand).toContain("long-running-workflows");
		expect(autoloopCommand).toContain(".opencode/workspace/autoloop/<slug>/");
		expect(autoloopCommand).toContain("continuation_status");
		expect(autoloopCommand).toContain("continuation_continue");
		expect(autoloopCommand).toContain("continuation_stop");
		expect(autoloopCommand).toContain("autoloop_status");
		expect(autoloopCommand).toContain("autoloop_checkpoint");
		expect(autoloopCommand).toContain("set `command` to `autoloop:<slug>`");
		expect(autoloopCommand).toContain(
			"Do not call `plan_list` just to adopt the currently active feature plan",
		);
		expect(autoloopCommand).toContain("dedicated workspace autoloop plan");
		expect(autoloopCommand).toContain(
			"keep the dedicated autoloop plan as the lifecycle source of truth",
		);
		expect(autoloopCommand).toContain(
			"Continue verified iterations until explicitly stopped or .paused exists",
		);
		expect(autoloopCommand).toContain("max_iterations = 50");
		expect(autoloopCommand).toContain(
			'do not switch into a normal completion summary or "next steps" handoff',
		);
		expect(autoloopCommand).toContain(
			"report only a concise running-status update",
		);
		expect(autoloopCommand).toContain(
			"prefer `autoloop_checkpoint` for locked monotonic appends",
		);
		expect(autoloopCommand).toContain("one slug and one git worktree per loop");
		expect(autoloopCommand).toContain("prefer `worktree_create`");
		expect(deslopCommand).toContain("analyze-mode");
		expect(deslopCommand).toContain("simplify");
		expect(deslopCommand).toContain("code-philosophy");
		expect(deslopCommand).toContain("<output_contract>");
		expect(deslopCommand).toContain("resolved base branch or fallback basis");
		expect(deslopCommand).not.toContain("origin/main");
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

		const chromeDevtoolsExists = await pathExists(
			"skills",
			"chrome-devtools",
			"SKILL.md",
		);
		expect(chromeDevtoolsExists).toBe(false);
	});

	test("prompt taxonomy documents layer ownership and shared defaults", async () => {
		const prompt = await readTemplate("PROMPT_TAXONOMY.md");

		expect(prompt).toContain("## Layer Ownership");
		expect(prompt).toContain("## Shared GPT-5.4 Defaults");
		expect(prompt).toContain("## Hook Responsibilities");
	});
});
