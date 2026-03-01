import { describe, expect, test } from "bun:test";
import type { DelegationRecord } from "../delegation/state";
import { buildTaskGraph } from "../task-graph/graph";

function record(
	input: Partial<DelegationRecord> & Pick<DelegationRecord, "id" | "status">,
): DelegationRecord {
	const now = "2026-03-01T00:00:00.000Z";
	return {
		id: input.id,
		root_session_id: input.root_session_id ?? "root-a",
		parent_session_id: input.parent_session_id ?? "parent-a",
		child_session_id: input.child_session_id ?? `child-${input.id}`,
		agent: input.agent ?? "general",
		prompt: input.prompt ?? "run",
		category: input.category,
		routing: input.routing,
		depends_on: input.depends_on,
		status: input.status,
		created_at: input.created_at ?? now,
		updated_at: input.updated_at ?? now,
		started_at: input.started_at,
		completed_at: input.completed_at,
		result: input.result,
		error: input.error,
	};
}

describe("task graph builder", () => {
	test("builds dependency edges and blocked metadata", () => {
		const graph = buildTaskGraph([
			record({ id: "a", status: "succeeded" }),
			record({ id: "b", status: "blocked", depends_on: ["a", "c"] }),
			record({ id: "c", status: "running" }),
		]);

		expect(graph.summary.total).toBe(3);
		expect(graph.summary.blocked).toBe(1);
		expect(graph.edges).toEqual([
			{ from: "a", to: "b", type: "dependency" },
			{ from: "c", to: "b", type: "dependency" },
		]);

		const nodeB = graph.nodes.find((node) => node.id === "b");
		expect(nodeB?.blocked_by).toEqual(["c"]);
	});

	test("supports filtering completed nodes", () => {
		const graph = buildTaskGraph(
			[
				record({ id: "done", status: "succeeded" }),
				record({ id: "queued", status: "queued" }),
			],
			{ includeCompleted: false },
		);

		expect(graph.summary.total).toBe(1);
		expect(graph.nodes.map((node) => node.id)).toEqual(["queued"]);
	});
});
