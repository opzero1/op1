import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, readdir, rm, tmpdir } from "../bun-compat";
import { WorkspacePlugin } from "../index";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

function createMockClient(
	sessionParents: Record<string, string | undefined> = {},
) {
	return {
		app: {
			log: async () => {},
		},
		session: {
			get: async (input: { path: { id: string } }) => {
				if (Object.hasOwn(sessionParents, input.path.id)) {
					const parentID = sessionParents[input.path.id];
					if (typeof parentID === "string") {
						return { data: { id: input.path.id, parentID } };
					}
				}

				return { data: { id: input.path.id } };
			},
			create: async () => ({ data: { id: "mock-child-session" } }),
			prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
			promptAsync: async () => ({}),
			messages: async () => ({ data: [] }),
			abort: async () => ({}),
		},
		config: {
			get: async () => ({ data: {} }),
		},
	};
}

const validPlan = `---
status: in-progress
phase: 1
updated: 2026-03-19
---

## Goal

Refine terse planning requests into confirmed implementation-ready plans

## Phase 1: Planning Contract [IN PROGRESS]

- [ ] **1.1 Capture repo-first pattern** ← CURRENT
- [ ] 1.2 Save draft before promotion
`;

describe("plan tools", () => {
	test("draft save, context write, and promote flow stays structured", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-plan-tools-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const planSaveTool = plugin.tool?.plan_save as unknown as {
			execute: (
				args: {
					content: string;
					mode: "draft";
				},
				toolCtx: { sessionID: string },
			) => Promise<string>;
		};
		const planContextWriteTool = plugin.tool?.plan_context_write as unknown as {
			execute: (
				args: Record<string, unknown>,
				toolCtx: { sessionID: string },
			) => Promise<string>;
		};
		const planPromoteTool = plugin.tool?.plan_promote as unknown as {
			execute: (
				args: { identifier: string },
				toolCtx: { sessionID: string },
			) => Promise<string>;
		};
		const planReadTool = plugin.tool?.plan_read as unknown as {
			execute: (
				args: { reason: string },
				toolCtx: { sessionID: string },
			) => Promise<string>;
		};

		expect(planSaveTool).toBeDefined();
		expect(planContextWriteTool).toBeDefined();
		expect(planPromoteTool).toBeDefined();
		expect(planReadTool).toBeDefined();

		const sessionID = "plan-session";
		const saveResult = await planSaveTool.execute(
			{ content: validPlan, mode: "draft" },
			{ sessionID },
		);
		expect(saveResult).toContain("draft created");

		const planFiles = (
			await readdir(join(root, ".opencode", "workspace", "plans"))
		).filter((name) => name.endsWith(".md"));
		expect(planFiles).toHaveLength(1);
		const planName = planFiles[0].replace(/\.md$/, "");

		const secondSaveResult = await planSaveTool.execute(
			{ content: validPlan.replace("repo-first", "repo-guided"), mode: "draft" },
			{ sessionID },
		);
		expect(secondSaveResult).toContain(planName);
		const planFilesAfterSecondSave = (
			await readdir(join(root, ".opencode", "workspace", "plans"))
		).filter((name) => name.endsWith(".md"));
		expect(planFilesAfterSecondSave).toHaveLength(1);

		const contextResult = await planContextWriteTool.execute(
			{
				plan_name: planName,
				stage: "confirmed",
				confirmed_by_user: true,
				goal: "Refine terse planning requests into confirmed implementation-ready plans",
				chosen_pattern: "repo-first staged refinement",
				affected_areas: [
					"packages/install/templates",
					"packages/workspace/src",
				],
				blast_radius: ["planner prompt flow", "workspace plan lifecycle"],
				success_criteria: ["draft exists before promotion"],
				failure_criteria: ["active plan replaced before approval"],
				test_plan: ["bun test packages/workspace", "bun test packages/install"],
				open_risks: ["prompt regressions"],
				question_answers_json: JSON.stringify([
					{
						question: "Is repo-first refinement the right default?",
						header: "Planning default",
						answers: ["Yes"],
						source: "question-tool",
						confirmed_by_user: true,
					},
				]),
				pattern_examples_json: JSON.stringify([
					{
						name: "Workspace plan save flow",
						example_files: ["packages/workspace/src/index.ts"],
						symbols: ["plan_save", "plan_promote"],
						why_it_fits:
							"The existing workspace plugin is the canonical place for plan lifecycle state.",
						constraints: ["Do not replace the active plan until approval"],
						blast_radius: ["workspace tools"],
						test_implications: ["plan-state tests"],
						confirmed_by_user: true,
					},
				]),
			},
			{ sessionID },
		);
		expect(contextResult).toContain("Saved structured planning context");

		const promoteResult = await planPromoteTool.execute(
			{ identifier: planName },
			{ sessionID },
		);
		expect(promoteResult).toContain("Promoted");

		const planReadResult = await planReadTool.execute(
			{ reason: "verify promoted plan" },
			{ sessionID },
		);
		expect(planReadResult).toContain("<plan-context>");
		expect(planReadResult).toContain("repo-first staged refinement");
		expect(planReadResult).toContain("Workspace plan save flow");
	});
});
