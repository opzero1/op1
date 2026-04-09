import { describe, expect, test } from "bun:test";
import type { TaskGraphNode, TaskGraphSnapshot } from "../task-graph.js";
import {
	formatGraphSummaryLine,
	formatGraphTree,
	formatNodeCategory,
	formatNodeDescription,
	formatNodeTitle,
	statusIcon,
	statusLabel,
} from "../tui/format.js";

function createNode(overrides: Partial<TaskGraphNode> = {}): TaskGraphNode {
	return {
		id: "task-1",
		description: "Implement helper",
		status: "running",
		agent: "coder",
		root_session_id: "root-1",
		parent_session_id: "parent-1",
		child_session_id: "child-1",
		depends_on: [],
		blocked_by: [],
		created_at: "2026-04-02T00:00:00.000Z",
		updated_at: "2026-04-02T00:00:00.000Z",
		...overrides,
	};
}

function createSnapshot(
	nodes: TaskGraphNode[],
	edges: TaskGraphSnapshot["edges"] = [],
): TaskGraphSnapshot {
	const summary = {
		total: nodes.length,
		queued: 0,
		blocked: 0,
		running: 0,
		succeeded: 0,
		failed: 0,
		cancelled: 0,
	};
	for (const n of nodes) summary[n.status] += 1;
	return { generated_at: new Date().toISOString(), summary, nodes, edges };
}

describe("statusIcon", () => {
	test("returns a symbol for each status", () => {
		expect(statusIcon("running")).toBe("\u25CF");
		expect(statusIcon("queued")).toBe("\u25CB");
		expect(statusIcon("succeeded")).toBe("\u2713");
		expect(statusIcon("failed")).toBe("\u2717");
		expect(statusIcon("blocked")).toBe("\u25C6");
		expect(statusIcon("cancelled")).toBe("\u2298");
	});
});

describe("statusLabel", () => {
	test("returns a readable label for each status", () => {
		expect(statusLabel("running")).toBe("running");
		expect(statusLabel("succeeded")).toBe("passed");
	});
});

describe("formatNodeTitle", () => {
	test("includes icon, padded status, agent, and description", () => {
		const title = formatNodeTitle(createNode());
		expect(title).toContain("\u25CF");
		expect(title).toContain("running");
		expect(title).toContain("coder");
		expect(title).toContain("Implement helper");
	});
});

describe("formatNodeDescription", () => {
	test("includes task id", () => {
		const desc = formatNodeDescription(createNode());
		expect(desc).toContain("id:task-1");
	});

	test("includes execution mode when present", () => {
		const desc = formatNodeDescription(
			createNode({ execution_mode: "worktree" }),
		);
		expect(desc).toContain("worktree");
	});

	test("includes merge status when not bypassed", () => {
		const desc = formatNodeDescription(createNode({ merge_status: "merged" }));
		expect(desc).toContain("merge:merged");
	});

	test("omits merge status when bypassed", () => {
		const desc = formatNodeDescription(
			createNode({ merge_status: "bypassed" }),
		);
		expect(desc).not.toContain("merge:");
	});

	test("includes blocked-by count", () => {
		const desc = formatNodeDescription(
			createNode({ blocked_by: ["dep-1", "dep-2"] }),
		);
		expect(desc).toContain("blocked by 2 task(s)");
	});

	test("includes branch when present", () => {
		const desc = formatNodeDescription(
			createNode({ branch: "op1/coder/task-1" }),
		);
		expect(desc).toContain("op1/coder/task-1");
	});
});

describe("formatNodeCategory", () => {
	test("groups running and queued as Active", () => {
		expect(formatNodeCategory(createNode({ status: "running" }))).toBe(
			"Active",
		);
		expect(formatNodeCategory(createNode({ status: "queued" }))).toBe("Active");
	});

	test("groups blocked as Blocked", () => {
		expect(formatNodeCategory(createNode({ status: "blocked" }))).toBe(
			"Blocked",
		);
	});

	test("groups terminal states as Completed", () => {
		expect(formatNodeCategory(createNode({ status: "succeeded" }))).toBe(
			"Completed",
		);
		expect(formatNodeCategory(createNode({ status: "failed" }))).toBe(
			"Completed",
		);
		expect(formatNodeCategory(createNode({ status: "cancelled" }))).toBe(
			"Completed",
		);
	});
});

describe("formatGraphSummaryLine", () => {
	test("includes total and per-status counts", () => {
		const snapshot = createSnapshot([
			createNode({ id: "a", status: "running" }),
			createNode({ id: "b", status: "queued" }),
			createNode({ id: "c", status: "succeeded" }),
		]);

		const line = formatGraphSummaryLine(snapshot);
		expect(line).toContain("3 total");
		expect(line).toContain("1 running");
		expect(line).toContain("1 queued");
		expect(line).toContain("1 passed");
	});

	test("omits zero-count statuses", () => {
		const snapshot = createSnapshot([
			createNode({ id: "a", status: "running" }),
		]);

		const line = formatGraphSummaryLine(snapshot);
		expect(line).not.toContain("queued");
		expect(line).not.toContain("failed");
	});
});

describe("formatGraphTree", () => {
	test("renders a flat list when no dependencies exist", () => {
		const snapshot = createSnapshot([
			createNode({ id: "a", description: "Task A" }),
			createNode({ id: "b", description: "Task B" }),
		]);

		const tree = formatGraphTree(snapshot);
		expect(tree).toContain("Task A");
		expect(tree).toContain("Task B");
	});

	test("renders children indented under parents", () => {
		const parent = createNode({ id: "parent", description: "Parent task" });
		const child = createNode({
			id: "child",
			description: "Child task",
			depends_on: ["parent"],
		});

		const snapshot = createSnapshot(
			[parent, child],
			[{ from: "parent", to: "child", type: "dependency" }],
		);

		const tree = formatGraphTree(snapshot);
		const lines = tree.split("\n");
		const firstLine = lines[0];
		expect(firstLine).toContain("Parent task");
		// child should be indented
		const childLine = lines.find((l) => l.includes("Child task"));
		expect(childLine).toBeDefined();
		expect(childLine?.indexOf("Child task")).toBeGreaterThan(
			firstLine?.indexOf("Parent task") ?? -1,
		);
	});
});
