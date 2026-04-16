import type { TaskRecord, TaskStatus } from "./state.js";

type TaskExecution = NonNullable<TaskRecord["execution"]>;
type TaskAssignment = NonNullable<TaskRecord["assignment"]>;
type TaskRetry = NonNullable<TaskAssignment["retry"]>;
type TaskReview = NonNullable<TaskAssignment["review"]>;

export interface CanonicalTaskPayload {
	task_id: string;
	reference: string;
	session_id: string;
	description: string;
	agent: string;
	root_model?: {
		provider_id: string;
		model_id: string;
		variant?: string;
	};
	status: TaskStatus;
	run_in_background: boolean;
	authoritative_context?: boolean;
	category?: TaskRecord["category"];
	execution: {
		mode: TaskExecution["mode"];
		branch?: string;
		worktree_path?: string;
		effective_root_path?: string;
		merge_status?: TaskExecution["merge_status"];
		verification_status?: TaskExecution["verification_status"];
		verification_strategy?: TaskExecution["verification_strategy"];
		verification_command?: TaskExecution["verification_command"];
		verification_summary?: TaskExecution["verification_summary"];
		diff_summary?: TaskExecution["diff_summary"];
		root_follow_through?: TaskExecution["root_follow_through"];
		read_count?: number;
		search_count?: number;
		planning_count?: number;
		edit_count?: number;
		other_count?: number;
		file_changed?: boolean;
		edit_or_blocked_threshold?: number;
		stale_reason?: string;
	};
	assignment?: {
		workflow?: TaskAssignment["workflow"];
		retry?: {
			state?: TaskRetry["state"];
			reason?: TaskRetry["reason"];
		};
		review?: {
			status?: TaskReview["status"];
		};
	};
	error?: string;
}

export function buildTaskPayload(task: TaskRecord): CanonicalTaskPayload {
	const assignment: CanonicalTaskPayload["assignment"] = {};
	if (task.assignment?.workflow) {
		assignment.workflow = task.assignment.workflow;
	}

	if (task.assignment?.retry?.state || task.assignment?.retry?.reason) {
		assignment.retry = {
			...(task.assignment.retry.state
				? { state: task.assignment.retry.state }
				: {}),
			...(task.assignment.retry.reason
				? { reason: task.assignment.retry.reason }
				: {}),
		};
	}

	if (task.assignment?.review?.status) {
		assignment.review = {
			status: task.assignment.review.status,
		};
	}

	return {
		task_id: task.id,
		reference: `ref:${task.id}`,
		session_id: task.child_session_id,
		description: task.description,
		agent: task.agent,
		...(task.root_model
			? {
					root_model: {
						provider_id: task.root_model.providerID,
						model_id: task.root_model.modelID,
						...(task.root_model.variant
							? { variant: task.root_model.variant }
							: {}),
					},
				}
			: {}),
		status: task.status,
		run_in_background: task.run_in_background,
		...(task.authoritative_context ? { authoritative_context: true } : {}),
		...(task.category ? { category: task.category } : {}),
		execution: {
			mode: task.execution?.mode ?? "direct",
			...(task.execution?.branch ? { branch: task.execution.branch } : {}),
			...(task.execution?.worktree_path
				? { worktree_path: task.execution.worktree_path }
				: {}),
			...(task.execution?.effective_root_path
				? { effective_root_path: task.execution.effective_root_path }
				: {}),
			...(task.execution?.merge_status
				? { merge_status: task.execution.merge_status }
				: {}),
			...(task.execution?.verification_status
				? { verification_status: task.execution.verification_status }
				: {}),
			...(task.execution?.verification_strategy
				? { verification_strategy: task.execution.verification_strategy }
				: {}),
			...(task.execution?.verification_command
				? { verification_command: task.execution.verification_command }
				: {}),
			...(task.execution?.verification_summary
				? { verification_summary: task.execution.verification_summary }
				: {}),
			...(task.execution?.diff_summary
				? { diff_summary: task.execution.diff_summary }
				: {}),
			...(task.execution?.root_follow_through
				? { root_follow_through: task.execution.root_follow_through }
				: {}),
			...(typeof task.execution?.read_count === "number"
				? { read_count: task.execution.read_count }
				: {}),
			...(typeof task.execution?.search_count === "number"
				? { search_count: task.execution.search_count }
				: {}),
			...(typeof task.execution?.planning_count === "number"
				? { planning_count: task.execution.planning_count }
				: {}),
			...(typeof task.execution?.edit_count === "number"
				? { edit_count: task.execution.edit_count }
				: {}),
			...(typeof task.execution?.other_count === "number"
				? { other_count: task.execution.other_count }
				: {}),
			...(typeof task.execution?.file_changed === "boolean"
				? { file_changed: task.execution.file_changed }
				: {}),
			...(typeof task.execution?.edit_or_blocked_threshold === "number"
				? {
						edit_or_blocked_threshold: task.execution.edit_or_blocked_threshold,
					}
				: {}),
			...(task.execution?.stale_reason
				? { stale_reason: task.execution.stale_reason }
				: {}),
		},
		...(Object.keys(assignment).length > 0 ? { assignment } : {}),
		...(task.error ? { error: task.error } : {}),
	};
}

export function buildTaskToolMetadata(
	task: TaskRecord,
): Record<string, unknown> {
	const payload = buildTaskPayload(task);

	return {
		taskId: payload.task_id,
		reference: payload.reference,
		sessionId: payload.session_id,
		agent: payload.agent,
		runInBackground: payload.run_in_background,
		executionMode: payload.execution.mode,
		status: payload.status,
		...(payload.root_model
			? {
					rootModel: {
						providerID: payload.root_model.provider_id,
						modelID: payload.root_model.model_id,
						...(payload.root_model.variant
							? { variant: payload.root_model.variant }
							: {}),
					},
				}
			: {}),
		...(payload.execution.branch ? { branch: payload.execution.branch } : {}),
		...(payload.execution.worktree_path
			? { worktreePath: payload.execution.worktree_path }
			: {}),
		...(payload.execution.effective_root_path
			? { effectiveRootPath: payload.execution.effective_root_path }
			: {}),
		...(payload.category ? { category: payload.category } : {}),
		...(payload.assignment?.workflow
			? { workflow: payload.assignment.workflow }
			: {}),
		...(payload.execution.verification_strategy
			? { verificationStrategy: payload.execution.verification_strategy }
			: {}),
		...(payload.assignment?.review?.status
			? { reviewStatus: payload.assignment.review.status }
			: {}),
		...(payload.assignment?.retry?.state
			? { retryState: payload.assignment.retry.state }
			: {}),
		...(payload.execution.root_follow_through?.status
			? {
					rootFollowThroughStatus: payload.execution.root_follow_through.status,
				}
			: {}),
		...(typeof payload.execution.read_count === "number"
			? { readCount: payload.execution.read_count }
			: {}),
		...(typeof payload.execution.search_count === "number"
			? { searchCount: payload.execution.search_count }
			: {}),
		...(typeof payload.execution.planning_count === "number"
			? { planningCount: payload.execution.planning_count }
			: {}),
		...(typeof payload.execution.edit_count === "number"
			? { editCount: payload.execution.edit_count }
			: {}),
		...(typeof payload.execution.file_changed === "boolean"
			? { fileChanged: payload.execution.file_changed }
			: {}),
		...(typeof payload.execution.edit_or_blocked_threshold === "number"
			? { editOrBlockedThreshold: payload.execution.edit_or_blocked_threshold }
			: {}),
		task: payload,
	};
}

export function buildTaskCollectionMetadata(
	tasks: TaskRecord[],
): Record<string, unknown> {
	const payloads = tasks.map((task) => buildTaskPayload(task));
	const taskIds = tasks.map((task) => task.id);

	if (tasks.length === 0) {
		return {
			count: 0,
			tasks: [],
			taskIds,
		};
	}

	if (tasks.length === 1) {
		return {
			...buildTaskToolMetadata(tasks[0]),
			count: 1,
			taskIds,
			tasks: payloads,
		};
	}

	return {
		count: tasks.length,
		taskIds,
		tasks: payloads,
	};
}
