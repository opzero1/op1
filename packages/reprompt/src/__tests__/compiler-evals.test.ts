import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicRepromptTools } from "../orchestration/public-tools.js";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots.length = 0;
});

interface CompilerEvalCase {
	name: string;
	simplePrompt: string;
	expectedTaskClass: string;
	mustInclude: string[];
	mustNotInclude?: string[];
}

const COMPILER_EVAL_CASES: CompilerEvalCase[] = [
	{
		name: "debug request keeps coding contracts",
		simplePrompt: "fix AuthService createSession and verify the behavior",
		expectedTaskClass: "debug",
		mustInclude: [
			"prompt_mode: compiler",
			"task_class: debug",
			"<verification_loop>",
			"<terminal_tool_hygiene>",
		],
	},
	{
		name: "plan request keeps planning contracts",
		simplePrompt: "plan the rollout and risks for reprompt v2",
		expectedTaskClass: "plan",
		mustInclude: [
			"prompt_mode: compiler",
			"task_class: plan",
			"<completeness_contract>",
		],
		mustNotInclude: ["<terminal_tool_hygiene>"],
	},
	{
		name: "research request keeps citation contracts",
		simplePrompt:
			"research the tradeoffs of compiler mode versus manual rewrite mode",
		expectedTaskClass: "research",
		mustInclude: [
			"prompt_mode: compiler",
			"task_class: research",
			"<citation_rules>",
			"<grounding_rules>",
		],
		mustNotInclude: ["<terminal_tool_hygiene>"],
	},
	{
		name: "missing prompt paths become explicit omissions",
		simplePrompt: "fix src/missing.ts and explain the rollout risk",
		expectedTaskClass: "debug",
		mustInclude: [
			"prompt_mode: compiler",
			"missing-prompt-path:src/missing.ts",
			"<missing_context>",
		],
	},
];

async function previewCompilerPrompt(simplePrompt: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "op1-reprompt-eval-"));
	tempRoots.push(root);
	await Bun.write(
		join(root, "src.ts"),
		"export class AuthService {\n  createSession() {}\n}\n",
	);

	const tools = createPublicRepromptTools({
		workspaceRoot: root,
		client: {
			session: {
				create: async () => ({ data: { id: "child" } }),
				prompt: async () => ({
					data: { parts: [{ type: "text", text: "ok" }] },
				}),
			},
		} as never,
		config: { enabled: true },
	});

	const tool = tools.reprompt as unknown as {
		execute: (
			args: {
				simple_prompt: string;
				evidence_paths: string[];
				execute: boolean;
			},
			ctx: Record<string, unknown>,
		) => Promise<string>;
	};

	return tool.execute(
		{
			simple_prompt: simplePrompt,
			evidence_paths: ["src.ts"],
			execute: false,
		},
		{
			sessionID: "parent",
			messageID: "msg",
			agent: "build",
			directory: root,
			worktree: root,
			callID: "call",
			abort: new AbortController().signal,
			ask: async () => {},
			metadata: async () => {},
		},
	);
}

describe("reprompt compiler evals", () => {
	for (const evalCase of COMPILER_EVAL_CASES) {
		test(evalCase.name, async () => {
			const result = await previewCompilerPrompt(evalCase.simplePrompt);

			expect(result).toContain(`task_class: ${evalCase.expectedTaskClass}`);
			for (const item of evalCase.mustInclude) {
				expect(result).toContain(item);
			}
			for (const item of evalCase.mustNotInclude ?? []) {
				expect(result).not.toContain(item);
			}
		});
	}
});
