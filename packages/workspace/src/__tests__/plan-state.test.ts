import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import {
	getJsonRecoveryObservabilitySnapshot,
	resetJsonRecoveryObservabilityState,
} from "../json-recovery-observability";
import { createStateManager } from "../plan/state";

async function createTempWorkspace(): Promise<{
	root: string;
	workspaceDir: string;
	plansDir: string;
	notepadsDir: string;
	activePlanPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-workspace-test-"));
	const workspaceDir = join(root, ".opencode", "workspace");
	const plansDir = join(workspaceDir, "plans");
	const notepadsDir = join(workspaceDir, "notepads");
	const activePlanPath = join(workspaceDir, "active-plan.json");

	await mkdir(plansDir, { recursive: true });
	await mkdir(notepadsDir, { recursive: true });

	return { root, workspaceDir, plansDir, notepadsDir, activePlanPath };
}

let tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
	resetJsonRecoveryObservabilityState();
});

describe("plan state manager", () => {
	test("recovers active plan when active-plan.json points to missing file", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const olderPlan = join(env.plansDir, "100-old.md");
		const newerPlan = join(env.plansDir, "200-new.md");
		await Bun.write(olderPlan, "# Plan\n\n## Goal\n\nOlder plan");
		await Bun.write(newerPlan, "# Plan\n\n## Goal\n\nNewer plan");

		await Bun.write(
			env.activePlanPath,
			JSON.stringify(
				{
					active_plan: join(env.plansDir, "missing.md"),
					started_at: "2026-01-01T00:00:00.000Z",
					session_ids: ["legacy-session"],
					plan_name: "missing",
				},
				null,
				2,
			),
		);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const state = await sm.readActivePlanState("session-1");
		expect(state).not.toBeNull();
		expect(state?.active_plan).toBe(newerPlan);
		expect(state?.session_ids).toContain("legacy-session");
		expect(state?.session_ids).toContain("session-1");

		const persisted = JSON.parse(await Bun.file(env.activePlanPath).text()) as {
			active_plan: string;
		};
		expect(persisted.active_plan).toBe(newerPlan);
	});

	test("supports linking docs with reverse backlinks", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const docPath = join(env.root, "docs", "feature-prd.md");
		await mkdir(join(env.root, "docs"), { recursive: true });
		await Bun.write(docPath, "# Feature PRD\n\nDetails");

		const firstLink = await sm.linkPlanDoc("plan-a", {
			path: docPath,
			type: "prd",
			phase: "2",
			task: "2.1",
			title: "Feature PRD",
		});

		await sm.linkPlanDoc("plan-b", {
			path: docPath,
			type: "prd",
			phase: "1",
		});

		const planALinks = await sm.getPlanDocLinks("plan-a");
		expect(planALinks).toHaveLength(1);
		expect(planALinks[0].id).toBe(firstLink.id);

		const doc = await sm.getPlanDocByID(firstLink.id);
		expect(doc).not.toBeNull();
		expect(doc?.linked_plans).toHaveLength(2);
		expect(doc?.linked_plans.map((item) => item.plan_name)).toContain("plan-a");
		expect(doc?.linked_plans.map((item) => item.plan_name)).toContain("plan-b");
	});

	test("resolves plan path by name", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const p1 = join(env.plansDir, "100-alpha.md");
		const p2 = join(env.plansDir, "200-beta.md");
		await Bun.write(p1, "# Plan\n\n## Goal\n\nAlpha");
		await Bun.write(p2, "# Plan\n\n## Goal\n\nBeta");

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const resolved = await sm.resolvePlanPath("200-beta");
		expect(resolved).toBe(p2);
	});

	test("archives active plan and promotes next non-archived plan", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const p1 = join(env.plansDir, "100-alpha.md");
		const p2 = join(env.plansDir, "200-beta.md");
		await Bun.write(p1, "# Plan\n\n## Goal\n\nAlpha");
		await Bun.write(p2, "# Plan\n\n## Goal\n\nBeta");

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		await sm.setActivePlan(p2, { sessionID: "session-1" });
		const archived = await sm.archivePlan("200-beta", {
			sessionID: "session-1",
		});

		expect(archived.archived.plan_name).toBe("200-beta");
		expect(archived.archived.lifecycle).toBe("archived");
		expect(archived.activePlan?.active_plan).toBe(p1);

		const persisted = await sm.readActivePlanState("session-1");
		expect(persisted?.active_plan).toBe(p1);

		const records = await sm.listPlanRecords();
		const beta = records.find((record) => record.plan_name === "200-beta");
		const alpha = records.find((record) => record.plan_name === "100-alpha");
		expect(beta?.lifecycle).toBe("archived");
		expect(alpha?.lifecycle).toBe("active");
	});

	test("cannot activate archived plan until unarchived", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const p1 = join(env.plansDir, "100-alpha.md");
		await Bun.write(p1, "# Plan\n\n## Goal\n\nAlpha");

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		await sm.archivePlan("100-alpha");

		await expect(sm.setActivePlan(p1)).rejects.toThrow(
			"Plan 100-alpha is archived. Unarchive before activating.",
		);

		await sm.unarchivePlan("100-alpha");
		const state = await sm.setActivePlan(p1, { sessionID: "session-2" });
		expect(state.plan_name).toBe("100-alpha");
	});

	test("stores structured plan context and promotes a draft plan", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const draftPath = join(env.plansDir, "100-alpha.md");
		await Bun.write(draftPath, "# Plan\n\n## Goal\n\nAlpha");

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		await sm.upsertPlanRegistryEntry(draftPath, { lifecycle: "draft" });
		await sm.syncPlanContext("100-alpha", {
			stage: "draft",
			goal: "Refine alpha planning flow",
			chosen_pattern: "repo-first plan refinement",
			affected_areas: ["packages/install", "packages/workspace"],
			blast_radius: ["prompt templates", "workspace plan lifecycle"],
			success_criteria: ["draft saved before promotion"],
			failure_criteria: ["weak plan saved without confirmation"],
			test_plan: ["bun test packages/workspace"],
			open_risks: ["prompt flow drift"],
			question_answers: [
				{
					id: "qa-1",
					question: "Is the repo-first pattern correct?",
					answers: ["Yes"],
					source: "question-tool",
					confirmed_by_user: true,
					captured_at: "2026-03-19T00:00:00.000Z",
				},
			],
			pattern_examples: [
				{
					name: "Workspace plan registry",
					example_files: ["packages/workspace/src/index.ts"],
					symbols: ["plan_save"],
					why_it_fits: "Existing plan persistence should stay canonical.",
					constraints: ["Keep active plan stable until approval"],
					blast_radius: ["workspace tools"],
					test_implications: ["plan-state tests"],
					confirmed_by_user: true,
				},
			],
		});

		const promoted = await sm.promotePlan("100-alpha", {
			sessionID: "session-1",
		});

		expect(promoted.plan_name).toBe("100-alpha");
		expect(promoted.active_plan).toBe(draftPath);

		const context = await sm.readPlanContext("100-alpha");
		expect(context?.stage).toBe("active");
		expect(context?.confirmed_by_user).toBe(true);
		expect(context?.pattern_examples[0]?.name).toBe("Workspace plan registry");

		const registry = await sm.readPlanRegistry();
		expect(registry.plans["100-alpha"]?.lifecycle).toBe("active");
	});

	test("unarchives an unconfirmed plan back to draft lifecycle", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const draftPath = join(env.plansDir, "100-alpha.md");
		await Bun.write(draftPath, "# Plan\n\n## Goal\n\nAlpha");

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		await sm.upsertPlanRegistryEntry(draftPath, { lifecycle: "draft" });
		await sm.syncPlanContext("100-alpha", {
			stage: "draft",
			confirmed_by_user: false,
		});

		await sm.archivePlan("100-alpha");
		const restored = await sm.unarchivePlan("100-alpha");

		expect(restored.lifecycle).toBe("draft");
		const context = await sm.readPlanContext("100-alpha");
		expect(context?.stage).toBe("draft");
	});

	test("recovers plan registry JSON with trailing commas", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const planPath = join(env.plansDir, "100-alpha.md");
		await Bun.write(planPath, "# Plan\n\n## Goal\n\nAlpha");

		const planRegistryPath = join(env.workspaceDir, "plan-registry.json");
		await Bun.write(
			planRegistryPath,
			`{
			  "version": 1,
			  "plans": {
			    "100-alpha": {
			      "path": "${planPath}",
			      "lifecycle": "inactive",
			      "created_at": "2026-02-20T00:00:00.000Z",
			      "updated_at": "2026-02-20T00:00:00.000Z",
			    },
			  },
			}`,
		);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const registry = await sm.readPlanRegistry();
		expect(registry.plans["100-alpha"]).toBeDefined();
		expect(registry.plans["100-alpha"].path).toBe(planPath);

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.match_total).toBe(1);
		expect(snapshot.per_method.trailing_comma_cleanup).toBe(1);
	});

	test("does not record recovery match when trailing comma recovery parse fails", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const planRegistryPath = join(env.workspaceDir, "plan-registry.json");
		await Bun.write(
			planRegistryPath,
			`{
			  "version": 1,
			  "plans": {
			    "broken": {
			      "path": "${join(env.plansDir, "100-broken.md")}",,
			      "lifecycle": "inactive",
			    },
			  },
			}`,
		);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const registry = await sm.readPlanRegistry();
		expect(registry.plans.broken).toBeUndefined();

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.parse_fail_total).toBe(1);
		expect(snapshot.match_total).toBe(0);
		expect(snapshot.per_method.trailing_comma_cleanup).toBe(0);
		expect(snapshot.per_method.object_boundary_extraction).toBe(0);
		expect(snapshot.per_method.array_boundary_extraction).toBe(0);
	});

	test("recovers active plan JSON from object boundary extraction", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const planPath = join(env.plansDir, "100-alpha.md");
		await Bun.write(planPath, "# Plan\n\n## Goal\n\nAlpha");

		await Bun.write(
			env.activePlanPath,
			`corrupted-prefix\n{"active_plan":"${planPath}","started_at":"2026-02-20T00:00:00.000Z","session_ids":["legacy"],"plan_name":"100-alpha"}\ncorrupted-suffix`,
		);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const state = await sm.readActivePlanState("session-3");
		expect(state).not.toBeNull();
		expect(state?.active_plan).toBe(planPath);
		expect(state?.session_ids).toContain("legacy");
		expect(state?.session_ids).toContain("session-3");
	});
});
