import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createDelegationStateManager } from "../delegation/state";
import {
	getJsonRecoveryObservabilitySnapshot,
	resetJsonRecoveryObservabilityState,
} from "../json-recovery-observability";

let tempRoots: string[] = [];

async function createTempWorkspace(): Promise<{
	root: string;
	workspaceDir: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-workspace-delegation-test-"));
	const workspaceDir = join(root, ".opencode", "workspace");
	await mkdir(workspaceDir, { recursive: true });
	return { root, workspaceDir };
}

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
	resetJsonRecoveryObservabilityState();
});

describe("delegation state manager", () => {
	test("persists queued->running->succeeded lifecycle", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-1",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-1",
			agent: "general",
			prompt: "run task",
		});

		const running = await manager.transitionDelegation("del-1", "running");
		expect(running.status).toBe("running");
		expect(running.started_at).toBeDefined();

		const done = await manager.transitionDelegation("del-1", "succeeded", {
			result: "result text",
		});
		expect(done.status).toBe("succeeded");
		expect(done.result).toBe("result text");
		expect(done.completed_at).toBeDefined();

		const reloaded = createDelegationStateManager(env.workspaceDir);
		const persisted = await reloaded.getDelegation("del-1");
		expect(persisted?.status).toBe("succeeded");
		expect(persisted?.result).toBe("result text");
	});

	test("persists delegation routing telemetry fields", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-routing",
			root_session_id: "root-routing",
			parent_session_id: "parent-routing",
			child_session_id: "child-routing",
			agent: "researcher",
			prompt: "Investigate docs",
			category: "research",
			routing: {
				detected_category: "research",
				chosen_agent: "researcher",
				confidence: 0.91,
				fallback_path: "none",
			},
		});

		const record = await manager.getDelegation("del-routing");
		expect(record?.category).toBe("research");
		expect(record?.routing?.chosen_agent).toBe("researcher");
		expect(record?.routing?.confidence).toBe(0.91);
	});

	test("persists tmux traceability metadata", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-tmux",
			root_session_id: "root-tmux",
			parent_session_id: "parent-tmux",
			child_session_id: "child-tmux",
			agent: "build",
			prompt: "run in tmux",
			tmux_session_name: "main",
			tmux_window_name: "op1-project-feature-a",
		});

		const record = await manager.getDelegation("del-tmux");
		expect(record?.tmux_session_name).toBe("main");
		expect(record?.tmux_window_name).toBe("op1-project-feature-a");
	});

	test("blocks invalid terminal transition", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-2",
			root_session_id: "root-1",
			parent_session_id: "parent-1",
			child_session_id: "child-2",
			agent: "general",
			prompt: "run task",
		});

		await manager.transitionDelegation("del-2", "running");
		await manager.transitionDelegation("del-2", "failed", {
			error: "failed reason",
		});

		await expect(
			manager.transitionDelegation("del-2", "running"),
		).rejects.toThrow("Invalid delegation transition");
	});

	test("lists delegations by root session scope", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-a",
			root_session_id: "root-a",
			parent_session_id: "parent-a",
			child_session_id: "child-a",
			agent: "general",
			prompt: "task a",
		});
		await manager.createDelegation({
			id: "del-b",
			root_session_id: "root-b",
			parent_session_id: "parent-b",
			child_session_id: "child-b",
			agent: "general",
			prompt: "task b",
		});

		const onlyRootA = await manager.listDelegations({
			root_session_id: "root-a",
		});
		expect(onlyRootA).toHaveLength(1);
		expect(onlyRootA[0]?.id).toBe("del-a");
	});

	test("applies status filter and limit", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-limit-a",
			root_session_id: "root-limit",
			parent_session_id: "parent-limit",
			child_session_id: "child-limit-a",
			agent: "general",
			prompt: "task a",
		});
		await manager.transitionDelegation("del-limit-a", "running");

		await manager.createDelegation({
			id: "del-limit-b",
			root_session_id: "root-limit",
			parent_session_id: "parent-limit",
			child_session_id: "child-limit-b",
			agent: "general",
			prompt: "task b",
		});

		const runningOnly = await manager.listDelegations({
			root_session_id: "root-limit",
			status: "running",
		});
		expect(runningOnly).toHaveLength(1);
		expect(runningOnly[0]?.id).toBe("del-limit-a");

		const limited = await manager.listDelegations({
			root_session_id: "root-limit",
			limit: 1,
		});
		expect(limited).toHaveLength(1);
	});

	test("supports queued/running cancellation lifecycle", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-cancel-queued",
			root_session_id: "root-cancel",
			parent_session_id: "parent-cancel",
			child_session_id: "child-cancel-queued",
			agent: "general",
			prompt: "queued cancellation",
		});

		const queuedCancelled = await manager.transitionDelegation(
			"del-cancel-queued",
			"cancelled",
			{ error: "Delegation session interrupted." },
		);
		expect(queuedCancelled.status).toBe("cancelled");
		expect(queuedCancelled.completed_at).toBeDefined();

		await manager.createDelegation({
			id: "del-cancel-running",
			root_session_id: "root-cancel",
			parent_session_id: "parent-cancel",
			child_session_id: "child-cancel-running",
			agent: "general",
			prompt: "running cancellation",
		});
		await manager.transitionDelegation("del-cancel-running", "running");

		const runningCancelled = await manager.transitionDelegation(
			"del-cancel-running",
			"cancelled",
			{ error: "Delegation cancelled by user request." },
		);
		expect(runningCancelled.status).toBe("cancelled");
		expect(runningCancelled.started_at).toBeDefined();
		expect(runningCancelled.completed_at).toBeDefined();

		await expect(
			manager.transitionDelegation("del-cancel-running", "running"),
		).rejects.toThrow("Invalid delegation transition");
	});

	test("creates blocked delegations until dependencies succeed", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await manager.createDelegation({
			id: "del-root",
			root_session_id: "root-graph",
			parent_session_id: "parent-graph",
			child_session_id: "child-root",
			agent: "general",
			prompt: "root",
		});

		const blocked = await manager.createDelegation({
			id: "del-child",
			root_session_id: "root-graph",
			parent_session_id: "parent-graph",
			child_session_id: "child-blocked",
			agent: "general",
			prompt: "blocked child",
			depends_on: ["del-root"],
		});

		expect(blocked.status).toBe("blocked");
		expect(blocked.depends_on).toEqual(["del-root"]);

		const initialRunnable = await manager.listRunnableBlockedDelegations({
			root_session_id: "root-graph",
		});
		expect(initialRunnable).toHaveLength(0);

		await manager.transitionDelegation("del-root", "running");
		await manager.transitionDelegation("del-root", "succeeded");

		const blockers = await manager.getBlockingDependencies("del-child");
		expect(blockers).toHaveLength(0);

		const runnable = await manager.listRunnableBlockedDelegations({
			root_session_id: "root-graph",
		});
		expect(runnable).toHaveLength(1);
		expect(runnable[0]?.id).toBe("del-child");
	});

	test("rejects unknown delegation dependencies", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createDelegationStateManager(env.workspaceDir);
		await expect(
			manager.createDelegation({
				id: "del-missing-dep",
				root_session_id: "root-graph",
				parent_session_id: "parent-graph",
				child_session_id: "child-missing",
				agent: "general",
				prompt: "missing dependency",
				depends_on: ["does-not-exist"],
			}),
		).rejects.toThrow("dependency 'does-not-exist'");
	});

	test("recovers malformed JSON with trailing commas", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const delegationsPath = join(env.workspaceDir, "delegations.json");
		await Bun.write(
			delegationsPath,
			`{
			  "version": 1,
			  "delegations": {
			    "swift-ocean-voyager": {
			      "id": "swift-ocean-voyager",
			      "root_session_id": "root-recovery",
			      "parent_session_id": "parent-recovery",
			      "child_session_id": "child-recovery",
			      "agent": "general",
			      "prompt": "recover me",
			      "status": "queued",
			      "created_at": "2026-03-01T00:00:00.000Z",
			      "updated_at": "2026-03-01T00:00:00.000Z",
			    },
			  },
			}`,
		);

		const manager = createDelegationStateManager(env.workspaceDir);
		const record = await manager.getDelegation("swift-ocean-voyager");
		expect(record?.status).toBe("queued");
		expect(record?.agent).toBe("general");
	});

	test("does not record recovery match when trailing comma recovery parse fails", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const delegationsPath = join(env.workspaceDir, "delegations.json");
		await Bun.write(
			delegationsPath,
			`{
			  "version": 1,
			  "delegations": {
			    "broken": {
			      "id": "broken",
			      "root_session_id": "root-broken",
			      "parent_session_id": "parent-broken",
			      "child_session_id": "child-broken",
			      "agent": "general",
			      "prompt": "broken payload",,
			      "status": "queued",
			      "created_at": "2026-03-01T00:00:00.000Z",
			      "updated_at": "2026-03-01T00:00:00.000Z",
			    },
			  },
			}`,
		);

		const manager = createDelegationStateManager(env.workspaceDir);
		const record = await manager.getDelegation("broken");
		expect(record).toBeNull();

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.parse_fail_total).toBe(1);
		expect(snapshot.match_total).toBe(0);
		expect(snapshot.per_method.trailing_comma_cleanup).toBe(0);
		expect(snapshot.per_method.object_boundary_extraction).toBe(0);
		expect(snapshot.per_method.array_boundary_extraction).toBe(0);
	});
});
