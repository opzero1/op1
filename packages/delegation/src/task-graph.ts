import type { TaskRecord, TaskStatus } from "./state.js";

type TerminalTaskStatus = "succeeded" | "failed" | "cancelled";
type TaskExecution = NonNullable<TaskRecord["execution"]>;
type TaskAssignment = NonNullable<TaskRecord["assignment"]>;
type TaskRetry = NonNullable<TaskAssignment["retry"]>;
type TaskReview = NonNullable<TaskAssignment["review"]>;

export interface TaskGraphNode {
	id: string;
	status: TaskStatus;
	agent: string;
	category?: TaskRecord["category"];
	manager_owned?: boolean;
	workflow?: TaskAssignment["workflow"];
	execution_mode?: TaskExecution["mode"];
	branch?: string;
	worktree_path?: string;
	effective_root_path?: string;
	merge_status?: TaskExecution["merge_status"];
	verification_status?: TaskExecution["verification_status"];
	verification_strategy?: TaskExecution["verification_strategy"];
	verification_summary?: TaskExecution["verification_summary"];
	diff_summary?: TaskExecution["diff_summary"];
	root_follow_through_status?: NonNullable<
		TaskExecution["root_follow_through"]
	>["status"];
	root_follow_through_reason?: NonNullable<
		TaskExecution["root_follow_through"]
	>["reason"];
	read_count?: number;
	search_count?: number;
	planning_count?: number;
	edit_count?: number;
	file_changed?: boolean;
	stale_reason?: string;
	retry_reason?: TaskRetry["reason"];
	retry_state?: TaskRetry["state"];
	last_resync_status?: TaskRetry["last_resync_status"];
	review_status?: TaskReview["status"];
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
			manager_owned:
				record.assignment?.owner === "manager" &&
				record.assignment.workflow === "caid",
			workflow: record.assignment?.workflow,
			execution_mode: record.execution?.mode,
			branch: record.execution?.branch,
			worktree_path: record.execution?.worktree_path,
			effective_root_path: record.execution?.effective_root_path,
			merge_status: record.execution?.merge_status,
			verification_status: record.execution?.verification_status,
			verification_strategy: record.execution?.verification_strategy,
			verification_summary: record.execution?.verification_summary,
			diff_summary: record.execution?.diff_summary,
			root_follow_through_status: record.execution?.root_follow_through?.status,
			root_follow_through_reason: record.execution?.root_follow_through?.reason,
			read_count: record.execution?.read_count,
			search_count: record.execution?.search_count,
			planning_count: record.execution?.planning_count,
			edit_count: record.execution?.edit_count,
			file_changed: record.execution?.file_changed,
			stale_reason: record.execution?.stale_reason,
			retry_reason: record.assignment?.retry?.reason,
			retry_state: record.assignment?.retry?.state,
			last_resync_status: record.assignment?.retry?.last_resync_status,
			review_status: record.assignment?.review?.status,
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
