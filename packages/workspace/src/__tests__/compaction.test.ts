import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createCompactionHook } from "../hooks/compaction";

const EXPECTED_CODEX_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("compaction hook", () => {
	test("injects active plan, notepad, and linked doc context", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-compaction-test-"));
		tempRoots.push(root);

		const planPath = join(root, "plan.md");
		const docsDir = join(root, "docs");
		await mkdir(docsDir, { recursive: true });
		const docPath = join(docsDir, "brief.md");

		await Bun.write(
			planPath,
			`---\nphase: 2\n---\n\n## Phase 2: Workflow [IN PROGRESS]\n- [ ] **2.1 Continue iterating** ← CURRENT\n- [ ] 2.2 Follow-up\n`,
		);
		await Bun.write(
			docPath,
			"# Brief\nLong-running workflow context doc preview.",
		);

		const hook = createCompactionHook({
			readActivePlanState: async () => ({
				active_plan: planPath,
				started_at: "2026-03-19T00:00:00Z",
				session_ids: ["session-a"],
				plan_name: "workflow-plan",
				title: "Workflow Plan",
			}),
			getNotepadDir: async () => join(root, "notepad"),
			readNotepadFile: async (file) => {
				if (file === "decisions.md") return "Decision: keep looping safely.";
				if (file === "learnings.md")
					return "Learning: compaction must preserve the current task.";
				return null;
			},
			getPlanDocLinks: async () => [
				{
					id: "doc-1",
					path: docPath,
					type: "notes",
					title: "Workflow Brief",
					phase: "2",
					task: "2.1",
					linked_at: "2026-03-19T00:00:00Z",
				},
			],
		});

		const output = { context: [] as string[], prompt: "" };
		await hook({ sessionID: "session-a" }, output);

		expect(output.context).toHaveLength(1);
		expect(output.prompt).toBe(EXPECTED_CODEX_COMPACTION_PROMPT);
		expect(output.context[0]).toContain("<workspace-context>");
		expect(output.context[0]).toContain("Workflow Plan");
		expect(output.context[0]).toContain(
			"Current task: - [ ] **2.1 Continue iterating** ← CURRENT",
		);
		expect(output.context[0]).toContain("Decision: keep looping safely.");
		expect(output.context[0]).toContain("Workflow Brief");
		expect(output.context[0]).toContain("Doc ID: doc-1");
	});

	test("skips injection when no active plan exists", async () => {
		const hook = createCompactionHook({
			readActivePlanState: async () => null,
			getNotepadDir: async () => null,
			readNotepadFile: async () => null,
			getPlanDocLinks: async () => [],
		});

		const output = { context: [] as string[], prompt: "" };
		await hook({ sessionID: "session-b" }, output);

		expect(output.context).toHaveLength(0);
		expect(output.prompt).toBe(EXPECTED_CODEX_COMPACTION_PROMPT);
	});
});
