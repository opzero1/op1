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
