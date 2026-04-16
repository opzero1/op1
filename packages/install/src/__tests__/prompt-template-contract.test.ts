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
		expect(prompt).toContain("when that tool is available");
		expect(prompt).toContain("mirror the confirmations into `notepad_write`");
		expect(prompt).toContain('plan_save(mode="new", set_active=true)');
		expect(prompt).toContain("bounded pattern-scout pass");
		expect(prompt).toContain("follow existing pattern?");
		expect(prompt).toContain("primary kind");
		expect(prompt).toContain("overlays");
		expect(prompt).toContain("deep-grill");
		expect(prompt).toContain("dependencies");
		expect(prompt).toContain("code_example");
		expect(prompt).toContain("forward-facing");
		expect(prompt).toContain("add / edit / delete");
		expect(prompt).toContain("file_change_map_json");
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
		expect(planCommand).toContain("when available");
		expect(planCommand).toContain("saved plan + `notepad_write`");
		expect(planCommand).toContain('plan_save(mode="new", set_active=true)');
		expect(planCommand).toContain("bounded internal pattern-scout pass");
		expect(planCommand).toContain("follow existing pattern?");
		expect(planCommand).toContain("source_type");
		expect(planCommand).toContain("primary kind");
		expect(planCommand).toContain("overlays");
		expect(planCommand).toContain("deep-grill");
		expect(planCommand).toContain("dependencies");
		expect(planCommand).toContain("forward-facing");
		expect(planCommand).toContain("file-operation change map");
		expect(planCommand).toContain("file_change_map_json");
		expect(planCommand).toContain("one question at a time");
		expect(planCommand).toContain("state ownership");
		expect(planCommand).toContain("Do not save any plan until");
		expect(planCommand).toContain(
			"planning-question-quality evaluation artifact",
		);
		expect(reviewCommand).toContain("code-review");
		expect(workCommand).toContain("plan_context_read");
		expect(workCommand).toContain("If `plan_context_read` is unavailable");
		expect(workCommand).toContain("approved implementation reference");
		expect(workCommand).toContain("/work` is the sole execution path");
		expect(workCommand).toContain(
			"switch out of `/work` for a direct small task",
		);
		expect(workCommand).toContain("run `/plan` first");
		expect(workCommand).toContain(
			"delegate/reroute implementation to `frontend`",
		);
		expect(workCommand).toContain(
			"do not execute that frontend implementation directly in `build`",
		);
		expect(workCommand).toContain("saved file change map");
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

	test("command templates avoid echoing raw $ARGUMENTS in prose", async () => {
		const commands = await Promise.all([
			readTemplate("commands", "plan.md"),
			readTemplate("commands", "deslop.md"),
			readTemplate("commands", "oracle.md"),
			readTemplate("commands", "understand.md"),
			readTemplate("commands", "research.md"),
			readTemplate("commands", "find.md"),
			readTemplate("commands", "init.md"),
			readTemplate("commands", "review-loop.md"),
		]);

		for (const command of commands) {
			expect(command).not.toContain("If `$ARGUMENTS` is empty");
			expect(command).not.toContain("from `$ARGUMENTS`");
			expect(command).not.toContain("If `$ARGUMENTS` contains");
			expect(command).not.toContain("If `$ARGUMENTS` names");
		}
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

	test("frontend ownership guidance stays consistent across build, coder, and ULW prompts", async () => {
		const [build, coder, frontend, ulw] = await Promise.all([
			readTemplate("agents", "build.md"),
			readTemplate("agents", "coder.md"),
			readTemplate("agents", "frontend.md"),
			readTemplate("skills", "ulw", "SKILL.md"),
		]);

		expect(build).toContain("Frontend ownership rule");
		expect(build).toContain("must go to `frontend`");
		expect(build).toContain("fail closed");
		expect(build).toContain("must be rerouted to `frontend`");
		expect(build).toContain("Only for non-frontend-owned changes");
		expect(build).toContain(
			"Never use this override for clearly frontend-owned work",
		);
		expect(build).toContain("authoritative_context");
		expect(build).toContain(
			"Do not rewrite `authoritative_context` into `prompt`",
		);
		expect(build).toContain("Preferred delegation shape");
		expect(coder).toContain("belongs to `frontend`");
		expect(coder).toContain("FE-adjacent logic or mixed tasks");
		expect(coder).toContain("<authoritative_context>");
		expect(coder).toContain("approved working set");
		expect(frontend).toContain("You ARE the frontend specialist");
		expect(frontend).toContain("<authoritative_context>");
		expect(frontend).toContain("approved working set");
		expect(ulw).toContain("| Frontend/UI | `frontend` |");
		expect(ulw).toContain("Use `frontend` for UI polish");
		expect(ulw).toContain("reroute to `frontend`");
		expect(ulw).toContain("Frontend-owned implementation");
	});

	test("frontend prompt treats tiny implementation work as edit-or-blocked execution", async () => {
		const frontend = await readTemplate("agents", "frontend.md");

		expect(frontend).toContain("short grounded read pass");
		expect(frontend).toContain("edit attempt or explicit blocked outcome");
		expect(frontend).toContain("Skip broad brand/emotion questionnaires");
		expect(frontend).toContain("trust it as the default scope");
		expect(frontend).toContain("do not broadly rediscover the repo");
		expect(frontend).toContain(
			"Stay inside the assigned execution root/worktree",
		);
		expect(frontend).toContain("Do not create nested worktrees");
		expect(frontend).toContain(
			"Use the smallest touched-scope verification command",
		);
	});

	test("/work execution guidance enforces frontend delegation over build direct handling", async () => {
		const work = await readTemplate("commands", "work.md");

		expect(work).toContain("clearly frontend-owned");
		expect(work).toContain("delegate/reroute implementation to `frontend`");
		expect(work).toContain(
			"do not execute that frontend implementation directly in `build`",
		);
	});

	test("long-running workflows skill defines durable state and pause controls", async () => {
		const prompt = await readTemplate(
			"skills",
			"long-running-workflows",
			"SKILL.md",
		);

		expect(prompt).toContain("name: long-running-workflows");
		expect(prompt).toContain("active plan (`plan_read`, `plan_save`)");
		expect(prompt).toContain(
			"structured plan context (`plan_context_read`, when available)",
		);
		expect(prompt).toContain("notepads (`notepad_read`, `notepad_write`)");
		expect(prompt).toContain("continuation_status");
		expect(prompt).toContain("continuation_stop");
		expect(prompt).not.toContain(".opencode/workspace/autoloop/<slug>/");
		expect(prompt).not.toContain("state.jsonl");
		expect(prompt).not.toContain(".paused");
		expect(prompt).not.toContain("dedicated autoloop plan");
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

	test("react-doctor guidance is vendored and referenced by React-focused prompts", async () => {
		const [build, coder, frontend, reviewer, review] = await Promise.all([
			readTemplate("agents", "build.md"),
			readTemplate("agents", "coder.md"),
			readTemplate("agents", "frontend.md"),
			readTemplate("agents", "reviewer.md"),
			readTemplate("commands", "review.md"),
		]);

		const reactDoctorSkill = await readTemplate(
			"skills",
			"react-doctor",
			"SKILL.md",
		);

		expect(reactDoctorSkill).toContain("name: react-doctor");
		expect(reactDoctorSkill).toContain(
			"npx -y react-doctor@latest . --verbose --diff",
		);
		expect(reactDoctorSkill).toContain(
			"uses `--diff` to focus on changed files",
		);

		for (const prompt of [build, coder, frontend]) {
			expect(prompt).toContain("react-doctor");
			expect(prompt).toContain("~/.config/opencode/skills/");
		}

		expect(build).toContain("prefer an installed official react-doctor skill");
		expect(build).toContain("replacement for lint, typecheck, build, or tests");
		expect(coder).toContain("Prefer an installed official react-doctor skill");
		expect(coder).toContain("additive verification");
		expect(frontend).toContain(
			"Prefer an installed official react-doctor skill",
		);
		expect(frontend).toContain("additive verification");

		expect(reviewer).not.toContain("react-doctor");
		expect(review).not.toContain("react-doctor");
	});

	test("prompt taxonomy documents layer ownership and shared defaults", async () => {
		const prompt = await readTemplate("PROMPT_TAXONOMY.md");

		expect(prompt).toContain("## Layer Ownership");
		expect(prompt).toContain("## Shared GPT-5.4 Defaults");
		expect(prompt).toContain("## Hook Responsibilities");
	});
});
