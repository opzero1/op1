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
	compatPlansDir: string;
	notepadsDir: string;
	activePlanPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-workspace-test-"));
	const workspaceDir = join(root, ".opencode", "workspace");
	const plansDir = join(workspaceDir, "plans");
	const compatPlansDir = join(root, ".opencode", "plans");
	const notepadsDir = join(workspaceDir, "notepads");
	const activePlanPath = join(workspaceDir, "active-plan.json");

	await mkdir(plansDir, { recursive: true });
	await mkdir(compatPlansDir, { recursive: true });
	await mkdir(notepadsDir, { recursive: true });

	return {
		root,
		workspaceDir,
		plansDir,
		compatPlansDir,
		notepadsDir,
		activePlanPath,
	};
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

	test("serializes concurrent plan doc registry writes", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const docPath = join(env.root, "docs", "eval-notes.md");
		await mkdir(join(env.root, "docs"), { recursive: true });
		await Bun.write(docPath, "# Eval Notes\n\nDetails");

		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				sm.linkPlanDoc(`plan-${index + 1}`, {
					path: docPath,
					type: "notes",
					phase: "3",
					task: `3.${index + 1}`,
					title: "Eval Notes",
				}),
			),
		);

		const registry = await sm.readPlanDocRegistry();
		const docEntry = Object.values(registry.docs).find(
			(doc) => doc.path === docPath,
		);
		expect(docEntry).toBeDefined();
		expect(docEntry?.linked_plans).toHaveLength(8);
		for (let index = 0; index < 8; index += 1) {
			expect(registry.plans[`plan-${index + 1}`]).toHaveLength(1);
		}
	});

	test("serializes concurrent plan registry patch writes", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		const planPaths = await Promise.all(
			Array.from({ length: 6 }, async (_, index) => {
				const planPath = join(
					env.plansDir,
					`${index + 1}00-plan-${index + 1}.md`,
				);
				await Bun.write(planPath, `# Plan\n\n## Goal\n\nPlan ${index + 1}`);
				return planPath;
			}),
		);

		await Promise.all(
			planPaths.map((planPath, index) =>
				sm.upsertPlanRegistryEntry(planPath, {
					title: `Title ${index + 1}`,
					description: `Description ${index + 1}`,
					lifecycle: index % 2 === 0 ? "draft" : "inactive",
				}),
			),
		);

		const registry = await sm.readPlanRegistry();
		for (let index = 0; index < planPaths.length; index += 1) {
			const planName = `${index + 1}00-plan-${index + 1}`;
			expect(registry.plans[planName]?.title).toBe(`Title ${index + 1}`);
			expect(registry.plans[planName]?.description).toBe(
				`Description ${index + 1}`,
			);
			expect(registry.plans[planName]?.lifecycle).toBe(
				index % 2 === 0 ? "draft" : "inactive",
			);
		}
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
			[env.compatPlansDir],
		);

		const resolved = await sm.resolvePlanPath("200-beta");
		expect(resolved).toBe(p2);
	});

	test("imports compatible plans from .opencode/plans into workspace registry", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const compatPlan = join(env.compatPlansDir, "300-compat.md");
		const importedPlan = join(env.plansDir, "300-compat.md");
		await Bun.write(compatPlan, "# Plan\n\n## Goal\n\nCompat");

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
			[env.compatPlansDir],
		);

		const resolved = await sm.resolvePlanPath("300-compat");
		expect(resolved).toBe(importedPlan);
		expect(await Bun.file(importedPlan).exists()).toBe(true);

		const records = await sm.listPlanRecords();
		expect(
			records.find((record) => record.plan_name === "300-compat")?.path,
		).toBe(importedPlan);
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

	test("serializes concurrent active-plan lifecycle updates", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const planPath = join(env.plansDir, "100-alpha.md");
		await Bun.write(planPath, "# Plan\n\n## Goal\n\nAlpha");

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		await Promise.all([
			sm.setActivePlan(planPath, { sessionID: "session-1" }),
			sm.setActivePlan(planPath, { sessionID: "session-2" }),
		]);

		const state = await sm.readActivePlanState();
		expect(state?.active_plan).toBe(planPath);
		expect(state?.session_ids).toContain("session-1");
		expect(state?.session_ids).toContain("session-2");

		const registry = await sm.readPlanRegistry();
		expect(registry.plans["100-alpha"]?.lifecycle).toBe("active");
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
			primary_kind: "implementation",
			overlays: ["deep-grill", "vertical-slices"],
			goal: "Refine alpha planning flow",
			non_goals: ["Do not modify prompt runtime"],
			happy_path: ["Capture context", "Implement phase 1"],
			expected_outcome: "Phase 1 contract is persistable and renderable.",
			missing_context_behavior: "Stop and ask one focused clarification.",
			approval_readiness_rules: ["Explicit user approval is required"],
			state_ownership: ["workspace state manager owns plan context files"],
			dependencies: ["workspace plan context must stay backward-readable"],
			triggers: ["plan_context_write updates structured state"],
			invariants: ["Keep one canonical current-state persistence path"],
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
					source_type: "repo",
					example_files: ["packages/workspace/src/index.ts"],
					symbols: ["plan_save"],
					why_it_fits: "Existing plan persistence should stay canonical.",
					constraints: ["Keep active plan stable until approval"],
					blast_radius: ["workspace tools"],
					test_implications: ["plan-state tests"],
					code_example:
						"await sm.syncPlanContext(planName, { pattern_examples: [...] });",
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
		expect(context?.primary_kind).toBe("implementation");
		expect(context?.overlays).toEqual(["deep-grill", "vertical-slices"]);
		expect(context?.non_goals).toEqual(["Do not modify prompt runtime"]);
		expect(context?.happy_path).toEqual([
			"Capture context",
			"Implement phase 1",
		]);
		expect(context?.expected_outcome).toBe(
			"Phase 1 contract is persistable and renderable.",
		);
		expect(context?.missing_context_behavior).toBe(
			"Stop and ask one focused clarification.",
		);
		expect(context?.approval_readiness_rules).toEqual([
			"Explicit user approval is required",
		]);
		expect(context?.state_ownership).toEqual([
			"workspace state manager owns plan context files",
		]);
		expect(context?.dependencies).toEqual([
			"workspace plan context must stay backward-readable",
		]);
		expect(context?.triggers).toEqual([
			"plan_context_write updates structured state",
		]);
		expect(context?.invariants).toEqual([
			"Keep one canonical current-state persistence path",
		]);
		expect(context?.pattern_examples[0]?.name).toBe("Workspace plan registry");
		expect(context?.pattern_examples[0]?.source_type).toBe("repo");
		expect(context?.pattern_examples[0]?.code_example).toContain(
			"syncPlanContext",
		);

		const registry = await sm.readPlanRegistry();
		expect(registry.plans["100-alpha"]?.lifecycle).toBe("active");
	});

	test("serializes concurrent plan context patch writes per plan", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		await Promise.all([
			sm.syncPlanContext("100-alpha", {
				stage: "draft",
				goal: "Refine alpha planning flow",
				affected_areas: ["packages/install"],
			}),
			sm.syncPlanContext("100-alpha", {
				chosen_pattern: "repo-first plan refinement",
				success_criteria: ["plan context merges concurrent updates"],
			}),
		]);

		const context = await sm.readPlanContext("100-alpha");
		expect(context?.stage).toBe("draft");
		expect(context?.goal).toBe("Refine alpha planning flow");
		expect(context?.chosen_pattern).toBe("repo-first plan refinement");
		expect(context?.affected_areas).toEqual(["packages/install"]);
		expect(context?.success_criteria).toEqual([
			"plan context merges concurrent updates",
		]);
	});

	test("merge-safe plan context updates preserve confirmed entries", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const sm = createStateManager(
			env.workspaceDir,
			env.plansDir,
			env.notepadsDir,
			env.activePlanPath,
		);

		await sm.syncPlanContext("100-alpha", {
			stage: "confirmed",
			primary_kind: "implementation",
			overlays: ["deep-grill"],
			non_goals: ["Avoid prompt-layer edits"],
			happy_path: ["Implement state model"],
			approval_readiness_rules: ["User confirmation required"],
			state_ownership: ["plan-contexts/*.json owned by workspace plugin"],
			dependencies: ["workspace context rendering must stay deterministic"],
			triggers: ["plan_context_write"],
			invariants: ["Keep plan context file canonical"],
			question_answers: [
				{
					id: "qa-merge-1",
					question: "Should we keep a single canonical state path?",
					header: "State path",
					answers: ["Yes"],
					source: "question-tool",
					confirmed_by_user: true,
					captured_at: "2026-03-19T00:00:00.000Z",
				},
			],
			pattern_examples: [
				{
					name: "Plan context sync",
					source_type: "repo",
					example_files: ["packages/workspace/src/plan/state.ts"],
					symbols: ["syncPlanContext"],
					why_it_fits: "State updates stay centralized and deterministic.",
					constraints: ["Avoid replacing confirmed arrays wholesale"],
					blast_radius: ["plan context persistence"],
					test_implications: ["plan-state tests"],
					confirmed_by_user: true,
				},
			],
		});

		await sm.syncPlanContext("100-alpha", {
			overlays: ["tdd"],
			non_goals: ["Avoid broad repo-wide refactors"],
			happy_path: ["Run focused tests"],
			approval_readiness_rules: ["Verification must pass before completion"],
			state_ownership: ["active-plan.json remains source of active selection"],
			dependencies: ["verification commands must stay package-scoped"],
			triggers: ["plan_promote"],
			invariants: ["No compatibility shim unless required"],
			question_answers: [
				{
					id: "qa-merge-2",
					question: "Should we keep a single canonical state path?",
					header: "State path",
					answers: ["Absolutely"],
					source: "freeform",
					confirmed_by_user: true,
					captured_at: "2026-03-20T00:00:00.000Z",
				},
			],
			pattern_examples: [
				{
					name: "Plan context sync",
					source_type: "repo",
					example_files: ["packages/workspace/src/index.ts"],
					symbols: ["plan_context_write"],
					why_it_fits: "Tool args map directly into structured context fields.",
					constraints: ["Preserve previously confirmed examples"],
					blast_radius: ["plan-context rendering"],
					test_implications: ["plan-tools tests"],
					confirmed_by_user: true,
				},
			],
		});

		const context = await sm.readPlanContext("100-alpha");
		expect(context).not.toBeNull();
		expect(context?.overlays).toEqual(["deep-grill", "tdd"]);
		expect(context?.non_goals).toEqual([
			"Avoid prompt-layer edits",
			"Avoid broad repo-wide refactors",
		]);
		expect(context?.happy_path).toEqual([
			"Implement state model",
			"Run focused tests",
		]);
		expect(context?.approval_readiness_rules).toEqual([
			"User confirmation required",
			"Verification must pass before completion",
		]);
		expect(context?.state_ownership).toEqual([
			"plan-contexts/*.json owned by workspace plugin",
			"active-plan.json remains source of active selection",
		]);
		expect(context?.dependencies).toEqual([
			"workspace context rendering must stay deterministic",
			"verification commands must stay package-scoped",
		]);
		expect(context?.triggers).toEqual(["plan_context_write", "plan_promote"]);
		expect(context?.invariants).toEqual([
			"Keep plan context file canonical",
			"No compatibility shim unless required",
		]);
		expect(context?.question_answers).toHaveLength(1);
		expect(context?.question_answers[0].answers).toEqual(["Yes", "Absolutely"]);
		expect(context?.pattern_examples).toHaveLength(1);
		expect(context?.pattern_examples[0].example_files).toEqual([
			"packages/workspace/src/plan/state.ts",
			"packages/workspace/src/index.ts",
		]);
		expect(context?.pattern_examples[0].symbols).toEqual([
			"syncPlanContext",
			"plan_context_write",
		]);
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
