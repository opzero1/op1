import type { TaskRecord, TaskStatus } from "./state.js";

type TerminalTaskStatus = "succeeded" | "failed" | "cancelled";

export interface TaskGraphNode {
	id: string;
	status: TaskStatus;
	agent: string;
	category?: TaskRecord["category"];
	root_session_id: string;
	parent_session_id: string;
	child_session_id: string;
	depends_on: string[];
	blocked_by: string[];
	created_at: string;
	updated_at: string;
	started_at?: string;
	completed_at?: string;
}

export interface TaskGraphEdge {
	from: string;
	to: string;
	type: "dependency";
}

export interface TaskGraphSnapshot {
	generated_at: string;
	summary: {
		total: number;
		queued: number;
		blocked: number;
		running: number;
		succeeded: number;
		failed: number;
		cancelled: number;
	};
	nodes: TaskGraphNode[];
	edges: TaskGraphEdge[];
}

function isTerminalStatus(status: TaskStatus): status is TerminalTaskStatus {
	return (
		status === "succeeded" || status === "failed" || status === "cancelled"
	);
}

function compareRecords(a: TaskRecord, b: TaskRecord): number {
	if (a.created_at === b.created_at) {
		return a.id.localeCompare(b.id);
	}

	return a.created_at.localeCompare(b.created_at);
}

export function buildTaskGraph(
	records: TaskRecord[],
	options?: { includeCompleted?: boolean },
): TaskGraphSnapshot {
	const includeCompleted = options?.includeCompleted ?? true;
	const byID = new Map(records.map((record) => [record.id, record]));
	const sorted = [...records].sort(compareRecords);

	const filtered = includeCompleted
		? sorted
		: sorted.filter((record) => !isTerminalStatus(record.status));

	const nodes: TaskGraphNode[] = filtered.map((record) => {
		const dependencies = record.depends_on ?? [];
		const blockedBy = dependencies.filter((dependencyID) => {
			const dependency = byID.get(dependencyID);
			return !dependency || dependency.status !== "succeeded";
		});

		return {
			id: record.id,
			status: record.status,
			agent: record.agent,
			category: record.category,
			root_session_id: record.root_session_id,
			parent_session_id: record.parent_session_id,
			child_session_id: record.child_session_id,
			depends_on: dependencies,
			blocked_by: blockedBy,
			created_at: record.created_at,
			updated_at: record.updated_at,
			started_at: record.started_at,
			completed_at: record.completed_at,
		};
	});

	const includedNodeIDs = new Set(nodes.map((node) => node.id));
	const edges: TaskGraphEdge[] = [];

	for (const node of nodes) {
		for (const dependencyID of node.depends_on) {
			if (!includedNodeIDs.has(dependencyID)) continue;
			edges.push({
				from: dependencyID,
				to: node.id,
				type: "dependency",
			});
		}
	}

	const summary = {
		total: nodes.length,
		queued: 0,
		blocked: 0,
		running: 0,
		succeeded: 0,
		failed: 0,
		cancelled: 0,
	};

	for (const node of nodes) {
		summary[node.status] += 1;
	}

	return {
		generated_at: new Date().toISOString(),
		summary,
		nodes,
		edges,
	};
}
