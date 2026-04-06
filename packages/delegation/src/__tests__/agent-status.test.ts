import { describe, expect, test } from "bun:test";
import { summarizeAgentStatus } from "../agent-status.js";
import type { TaskRecord } from "../state.js";

function task(
	status: TaskRecord["status"],
	overrides?: Partial<TaskRecord>,
): TaskRecord {
	return {
		id: "task-1",
		root_session_id: "root-1",
		parent_session_id: "parent-1",
		child_session_id: "child-1",
		description: "Implement helper",
		agent: "coder",
		prompt: "Add the helper",
		run_in_background: true,
		status,
		created_at: "2026-04-02T00:00:00.000Z",
		updated_at: "2026-04-02T00:00:00.000Z",
		...overrides,
	};
}

describe("delegation agent status", () => {
	test("surfaces frontend no-edit telemetry for running and blocked tasks", () => {
		const snapshot = summarizeAgentStatus([
			task("running", {
				agent: "frontend",
				execution: {
					mode: "worktree",
					read_count: 2,
					search_count: 1,
					planning_count: 1,
					edit_count: 0,
				},
			}),
			task("blocked", {
				id: "task-2",
				agent: "frontend",
				execution: {
					mode: "worktree",
					read_count: 3,
					search_count: 0,
					planning_count: 0,
					edit_count: 0,
				},
			}),
		]);

		expect(snapshot.indicators.frontend_no_edit_running_count).toBe(1);
		expect(snapshot.indicators.frontend_no_edit_blocked_count).toBe(1);
	});
});
