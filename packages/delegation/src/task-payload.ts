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
	status: TaskStatus;
	run_in_background: boolean;
	category?: TaskRecord["category"];
	execution: {
		mode: TaskExecution["mode"];
		branch?: string;
		worktree_path?: string;
		merge_status?: TaskExecution["merge_status"];
		verification_status?: TaskExecution["verification_status"];
		verification_strategy?: TaskExecution["verification_strategy"];
		verification_command?: TaskExecution["verification_command"];
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
		status: task.status,
		run_in_background: task.run_in_background,
		...(task.category ? { category: task.category } : {}),
		execution: {
			mode: task.execution?.mode ?? "direct",
			...(task.execution?.branch ? { branch: task.execution.branch } : {}),
			...(task.execution?.worktree_path
				? { worktree_path: task.execution.worktree_path }
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
		...(payload.execution.branch ? { branch: payload.execution.branch } : {}),
		...(payload.execution.worktree_path
			? { worktreePath: payload.execution.worktree_path }
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
