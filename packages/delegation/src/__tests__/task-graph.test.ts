import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "../state.js";
import { buildTaskGraph } from "../task-graph.js";

function createTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id: "task-1",
		root_session_id: "root-1",
		parent_session_id: "parent-1",
		child_session_id: "child-1",
		description: "Implement helper",
		agent: "coder",
		prompt: "Add the helper",
		run_in_background: true,
		status: "queued",
		created_at: "2026-04-02T00:00:00.000Z",
		updated_at: "2026-04-02T00:00:00.000Z",
		...overrides,
	};
}

describe("task graph", () => {
	test("includes execution metadata for worktree-backed tasks", () => {
		const graph = buildTaskGraph([
			createTask({
				assignment: {
					owner: "manager",
					workflow: "caid",
					retry: {
						reason: "merge_conflict",
						state: "resync_required",
						last_resync_status: "failed",
					},
					review: {
						status: "pending",
					},
				},
				execution: {
					mode: "worktree",
					branch: "op1/coder/task-1",
					worktree_path: "/tmp/task-1",
					effective_root_path: "/tmp/task-1",
					merge_status: "pending",
					verification_status: "pending",
					verification_strategy: "targeted",
					verification_summary: "bun test ./packages/delegation passed",
					diff_summary: "Changed files (1): packages/delegation/src/index.ts.",
					root_follow_through: {
						status: "pending",
						updated_at: "2026-04-06T00:00:00.000Z",
						reason: "Root continuation is stopped.",
						source: "continuation-stopped",
					},
					read_count: 2,
					search_count: 1,
					planning_count: 1,
					edit_count: 0,
					file_changed: false,
					stale_reason: "still reading",
				},
			}),
		]);

		expect(graph.nodes[0]).toMatchObject({
			manager_owned: true,
			workflow: "caid",
			execution_mode: "worktree",
			branch: "op1/coder/task-1",
			worktree_path: "/tmp/task-1",
			effective_root_path: "/tmp/task-1",
			merge_status: "pending",
			verification_status: "pending",
			verification_strategy: "targeted",
			verification_summary: "bun test ./packages/delegation passed",
			diff_summary: "Changed files (1): packages/delegation/src/index.ts.",
			root_follow_through_status: "pending",
			root_follow_through_reason: "Root continuation is stopped.",
			read_count: 2,
			search_count: 1,
			planning_count: 1,
			edit_count: 0,
			file_changed: false,
			stale_reason: "still reading",
			retry_reason: "merge_conflict",
			retry_state: "resync_required",
			last_resync_status: "failed",
			review_status: "pending",
		});
	});
});
