import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat.js";
import { createTaskStateManager } from "../state.js";

let tempRoots: string[] = [];

async function createTempWorkspace(): Promise<{
	root: string;
	workspaceDir: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-delegation-state-"));
	const workspaceDir = join(root, ".opencode", "workspace");
	await mkdir(workspaceDir, { recursive: true });
	return { root, workspaceDir };
}

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
});

describe("task state manager", () => {
	test("persists queued -> running -> succeeded lifecycle", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "calm-aqua-anchor",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			description: "Explore code",
			agent: "explore",
			prompt: "Inspect the codebase",
			run_in_background: true,
		});

		const running = await state.transitionTask("calm-aqua-anchor", "running");
		expect(running.status).toBe("running");
		expect(running.started_at).toBeDefined();

		const done = await state.transitionTask("calm-aqua-anchor", "succeeded", {
			result: "done",
		});
		expect(done.status).toBe("succeeded");
		expect(done.result).toBe("done");

		const reloaded = createTaskStateManager(env.workspaceDir);
		const persisted = await reloaded.getTask("calm-aqua-anchor");
		expect(persisted?.status).toBe("succeeded");
		expect(persisted?.description).toBe("Explore code");
	});

	test("persists worktree execution metadata", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "sunny-worktree-task",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			description: "Implement helper",
			agent: "coder",
			prompt: "Add the helper",
			execution: {
				mode: "worktree",
				branch: "op1/coder/sunny-worktree-task",
				base_branch: "main",
				worktree_path: "/tmp/op1-worktree",
				merge_status: "pending",
				verification_status: "pending",
				root_follow_through: {
					status: "pending",
					updated_at: "2026-04-06T00:00:00.000Z",
					reason: "Awaiting root follow-through",
					source: "launch",
				},
			},
			authoritative_context: "Target files: packages/delegation/src/index.ts",
			run_in_background: true,
		});

		const persisted = await createTaskStateManager(env.workspaceDir).getTask(
			"sunny-worktree-task",
		);

		expect(persisted?.execution).toMatchObject({
			mode: "worktree",
			branch: "op1/coder/sunny-worktree-task",
			base_branch: "main",
			worktree_path: "/tmp/op1-worktree",
			merge_status: "pending",
			verification_status: "pending",
			root_follow_through: {
				status: "pending",
				reason: "Awaiting root follow-through",
				source: "launch",
			},
		});
		expect(persisted?.authoritative_context).toContain("Target files");
	});

	test("persists root model selection metadata", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "model-selection-task",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			root_model: {
				providerID: "openai",
				modelID: "gpt-5.4",
				variant: "xhigh",
			},
			description: "Implement helper",
			agent: "coder",
			prompt: "Add the helper",
			run_in_background: true,
		});

		const persisted = await createTaskStateManager(env.workspaceDir).getTask(
			"model-selection-task",
		);

		expect(persisted?.root_model).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4",
			variant: "xhigh",
		});
	});

	test("persists frontend reroute routing telemetry", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "frontend-reroute-task",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			description: "Polish settings page",
			agent: "frontend",
			prompt: "Polish the settings page accessibility states.",
			routing: {
				detected_category: "visual",
				chosen_agent: "frontend",
				confidence: 0.9,
				fallback_path: "frontend-reroute",
			},
			run_in_background: true,
		});

		const persisted = await createTaskStateManager(env.workspaceDir).getTask(
			"frontend-reroute-task",
		);

		expect(persisted?.routing).toMatchObject({
			detected_category: "visual",
			chosen_agent: "frontend",
			fallback_path: "frontend-reroute",
		});
	});

	test("restarts a completed task on the same session", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "swift-ocean-voyager",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			description: "Initial task",
			agent: "coder",
			prompt: "First prompt",
			run_in_background: false,
			initial_status: "running",
		});
		await state.transitionTask("swift-ocean-voyager", "succeeded", {
			result: "first",
		});

		const restarted = await state.restartTask({
			id: "swift-ocean-voyager",
			description: "Follow-up task",
			prompt: "Second prompt",
			run_in_background: true,
			initial_status: "queued",
		});

		expect(restarted.status).toBe("queued");
		expect(restarted.child_session_id).toBe("child-1");
		expect(restarted.description).toBe("Follow-up task");
		expect(restarted.result).toBeUndefined();
		expect(restarted.error).toBeUndefined();
	});

	test("persists manager-owned assignment schema", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "dep-1",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-dep",
			description: "Dependency",
			agent: "explore",
			prompt: "Dependency task",
			run_in_background: true,
		});
		await state.transitionTask("dep-1", "running");
		await state.transitionTask("dep-1", "succeeded");

		await state.createTask({
			id: "caid-task-1",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			description: "Manager owned task",
			agent: "coder",
			prompt: "Implement the feature",
			depends_on: ["dep-1"],
			assignment: {
				owner: "manager",
				workflow: "caid",
				dependency_ids: ["dep-1"],
				retry: {
					reason: "merge_conflict",
					state: "resync_required",
					last_resync_status: "failed",
					last_resync_at: "2026-04-03T00:00:00.000Z",
					last_resync_summary: "conflict summary",
				},
				verification: {
					strategy: "targeted",
					candidate_commands: ["bun test ./packages/delegation"],
					selected_command: "bun test ./packages/delegation",
					fallback_command: "bun test",
					selection_reason: "single package touched",
				},
				review: {
					status: "pending",
					summary: "Manager review pending",
				},
			},
			run_in_background: true,
		});

		const persisted = await createTaskStateManager(env.workspaceDir).getTask(
			"caid-task-1",
		);

		expect(persisted?.assignment).toMatchObject({
			owner: "manager",
			workflow: "caid",
			dependency_ids: ["dep-1"],
			retry: {
				reason: "merge_conflict",
				state: "resync_required",
				last_resync_status: "failed",
			},
			verification: {
				strategy: "targeted",
				selected_command: "bun test ./packages/delegation",
			},
			review: {
				status: "pending",
			},
		});
	});

	test("orders manager-owned promotable tasks by dependency depth", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "dep-root",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-root",
			description: "Dependency root",
			agent: "coder",
			prompt: "Root task",
			assignment: {
				owner: "manager",
				workflow: "caid",
			},
			run_in_background: true,
		});
		await state.transitionTask("dep-root", "running");
		await state.transitionTask("dep-root", "succeeded");
		await state.createTask({
			id: "manager-ready",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-ready",
			description: "Manager ready",
			agent: "coder",
			prompt: "Ready task",
			assignment: {
				owner: "manager",
				workflow: "caid",
			},
			run_in_background: true,
		});
		await state.createTask({
			id: "manager-dependent",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-2",
			description: "Dependency child",
			agent: "coder",
			prompt: "Child task",
			depends_on: ["dep-root"],
			assignment: {
				owner: "manager",
				workflow: "caid",
				dependency_ids: ["dep-root"],
			},
			run_in_background: true,
		});
		await state.createTask({
			id: "ordinary-task",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-3",
			description: "Ordinary task",
			agent: "explore",
			prompt: "Inspect repo",
			run_in_background: true,
		});

		const promotable = await state.listPromotableTasks({
			root_session_id: "root-1",
		});

		expect(promotable.map((task) => task.id)).toEqual([
			"manager-ready",
			"manager-dependent",
			"ordinary-task",
		]);
	});

	test("keeps manager review-pending and resync-required tasks out of promotion", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const state = createTaskStateManager(env.workspaceDir);
		await state.createTask({
			id: "review-pending-task",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			description: "Await review",
			agent: "coder",
			prompt: "Await review",
			assignment: {
				owner: "manager",
				workflow: "caid",
				review: { status: "pending" },
			},
			run_in_background: true,
			initial_status: "blocked",
		});
		await state.createTask({
			id: "resync-task",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-2",
			description: "Await resync",
			agent: "coder",
			prompt: "Retry after resync",
			assignment: {
				owner: "manager",
				workflow: "caid",
				retry: {
					reason: "merge_conflict",
					state: "resync_required",
				},
			},
			execution: {
				mode: "worktree",
				merge_status: "conflicted",
			},
			run_in_background: true,
			initial_status: "blocked",
		});

		const promotable = await state.listPromotableTasks({
			root_session_id: "root-1",
		});

		expect(promotable).toHaveLength(0);
	});

	test("reads legacy version-3 task records from delegations.json", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		await Bun.write(
			join(env.workspaceDir, "delegations.json"),
			JSON.stringify(
				{
					version: 3,
					delegations: {
						"rapid-sierra-trail": {
							id: "rapid-sierra-trail",
							root_session_id: "root-1",
							parent_session_id: "parent-1",
							child_session_id: "child-1",
							description: "Legacy task",
							agent: "explore",
							prompt: "Inspect the codebase",
							run_in_background: true,
							status: "queued",
							created_at: "2026-03-06T00:00:00.000Z",
							updated_at: "2026-03-06T00:00:00.000Z",
						},
					},
				},
				null,
				2,
			),
		);

		const state = createTaskStateManager(env.workspaceDir);
		const task = await state.getTask("rapid-sierra-trail");

		expect(task?.description).toBe("Legacy task");
		expect(task?.run_in_background).toBe(true);
	});

	test("ignores workspace version-2 delegations when task-records are absent", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		await Bun.write(
			join(env.workspaceDir, "delegations.json"),
			JSON.stringify(
				{
					version: 2,
					delegations: {
						"legacy-workspace-record": {
							id: "legacy-workspace-record",
							root_session_id: "root-1",
							parent_session_id: "parent-1",
							child_session_id: "child-1",
							agent: "explore",
							prompt: "Inspect the codebase",
							status: "queued",
							created_at: "2026-03-06T00:00:00.000Z",
							updated_at: "2026-03-06T00:00:00.000Z",
						},
					},
				},
				null,
				2,
			),
		);

		const state = createTaskStateManager(env.workspaceDir);
		const task = await state.getTask("legacy-workspace-record");

		expect(task).toBeNull();
	});
});
