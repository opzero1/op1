import { type Plugin, tool } from "@opencode-ai/plugin";
import { summarizeAgentStatus } from "./agent-status.js";
import { enforceToolApproval } from "./approval.js";
import { join, mkdir } from "./bun-compat.js";
import { generateTaskID } from "./ids.js";
import { createLogger } from "./logging.js";
import {
	extractLatestAssistantText,
	extractPromptResponseText,
	formatFullSession,
} from "./messages.js";
import {
	type DelegationCategory,
	type DelegationRoutingTelemetry,
	parseDelegationCategory,
	resolveDelegationRouting,
} from "./router.js";
import {
	createTaskStateManager,
	type TaskRecord,
	type TaskStateManager,
	type TaskStatus,
} from "./state.js";
import { buildTaskGraph } from "./task-graph.js";
import { createToolMetadataStore } from "./tool-metadata.js";
import type {
	BackgroundCancelArgs,
	BackgroundOutputArgs,
	DelegationClient,
	DelegationToolContext,
	DelegationToolExecuteAfterInput,
	DelegationToolResult,
	TaskToolArgs,
} from "./types.js";
import { sleep } from "./utils.js";

const MAX_RUNNING_PER_AGENT = 5;
const DEFAULT_BLOCK_TIMEOUT_MS = 60_000;

interface RuntimeEvent {
	type?: string;
	properties?: Record<string, unknown>;
}

function getEventSessionID(event: RuntimeEvent): string | null {
	const properties = event.properties;
	if (!properties) return null;

	if (typeof properties.sessionID === "string") {
		return properties.sessionID;
	}

	if (typeof properties.id === "string") {
		return properties.id;
	}

	const info = properties.info;
	if (!info || typeof info !== "object") return null;

	const infoRecord = info as Record<string, unknown>;
	if (typeof infoRecord.sessionID === "string") {
		return infoRecord.sessionID;
	}

	if (typeof infoRecord.id === "string") {
		return infoRecord.id;
	}

	return null;
}

function getEventError(event: RuntimeEvent): string {
	const properties = event.properties;
	if (!properties) return "Session error event received";

	if (typeof properties.error === "string") {
		return properties.error;
	}

	if (typeof properties.message === "string") {
		return properties.message;
	}

	const errorValue = properties.error;
	if (errorValue && typeof errorValue === "object") {
		const errorRecord = errorValue as Record<string, unknown>;
		if (typeof errorRecord.message === "string") {
			return errorRecord.message;
		}
	}

	return "Session error event received";
}

function getSessionIDFromCreateResponse(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;
	return typeof record.id === "string" ? record.id : null;
}

function isActiveTask(status: TaskStatus): boolean {
	return status === "queued" || status === "blocked" || status === "running";
}

function getToolCallID(toolCtx: DelegationToolContext): string | null {
	const callID = toolCtx.callID ?? toolCtx.callId ?? toolCtx.call_id;
	if (typeof callID !== "string") return null;
	const trimmed = callID.trim();
	return trimmed.length > 0 ? trimmed : null;
}

async function emitToolMetadata(
	toolCtx: DelegationToolContext,
	toolMetadata: ReturnType<typeof createToolMetadataStore>,
	input: {
		title: string;
		metadata: Record<string, unknown>;
	},
): Promise<void> {
	await toolCtx.metadata?.(input);
	if (!toolCtx.sessionID) return;

	const callID = getToolCallID(toolCtx);
	if (!callID) return;

	toolMetadata.storeToolMetadata(toolCtx.sessionID, callID, input);
}

function mergeToolMetadata(
	output: DelegationToolResult,
	stored: {
		title?: string;
		metadata?: Record<string, unknown>;
	},
): void {
	if (stored.title) {
		output.title = stored.title;
	}

	if (!stored.metadata) return;

	const current =
		output.metadata && typeof output.metadata === "object"
			? output.metadata
			: {};
	output.metadata = {
		...current,
		...stored.metadata,
	};
}

function formatTaskMetadata(task: TaskRecord): string {
	return [
		"<task_metadata>",
		`task_id: ${task.id}`,
		`reference: ref:${task.id}`,
		`session_id: ${task.child_session_id}`,
		"</task_metadata>",
	].join("\n");
}

function formatTaskStatus(task: TaskRecord): string {
	const lines = [
		`Task ID: ${task.id}`,
		`Reference: ref:${task.id}`,
		`Session ID: ${task.child_session_id}`,
		`Description: ${task.description}`,
		`Agent: ${task.agent}`,
		`Status: ${task.status}`,
	];

	if (task.error) {
		lines.push(`Error: ${task.error}`);
	}

	return `${lines.join("\n")}\n\n${formatTaskMetadata(task)}`;
}

function formatBackgroundLaunch(task: TaskRecord): string {
	return [
		"Background task launched.",
		"",
		`Task ID: ${task.id}`,
		`Reference: ref:${task.id}`,
		`Session ID: ${task.child_session_id}`,
		`Description: ${task.description}`,
		`Agent: ${task.agent}`,
		`Status: ${task.status}`,
		"",
		`Use \`background_output(task_id="${task.id}")\` to inspect the task.`,
		"",
		formatTaskMetadata(task),
	].join("\n");
}

function formatSyncCompletion(task: TaskRecord, result: string): string {
	return [
		"Task completed.",
		"",
		`Task ID: ${task.id}`,
		`Reference: ref:${task.id}`,
		`Session ID: ${task.child_session_id}`,
		`Description: ${task.description}`,
		`Agent: ${task.agent}`,
		"",
		"---",
		"",
		result || "(No text output)",
		"",
		formatTaskMetadata(task),
	].join("\n");
}

async function getRootSessionID(
	client: DelegationClient,
	sessionID?: string,
): Promise<string> {
	if (!sessionID) {
		throw new Error("sessionID is required to resolve root session scope");
	}

	let currentID = sessionID;
	for (let depth = 0; depth < 20; depth += 1) {
		const session = await client.session.get({
			path: { id: currentID },
		});

		const data =
			session.data && typeof session.data === "object"
				? (session.data as Record<string, unknown>)
				: null;
		if (!data) {
			return currentID;
		}

		if (typeof data.parentID !== "string" || data.parentID.length === 0) {
			return currentID;
		}

		currentID = data.parentID;
	}

	return currentID;
}

async function getRunningCount(
	state: TaskStateManager,
	concurrencyKey: string,
): Promise<number> {
	const running = await state.listTasks({
		status: "running",
		concurrency_key: concurrencyKey,
		run_in_background: true,
		limit: 500,
	});
	return running.length;
}

async function startTaskSession(
	client: DelegationClient,
	task: TaskRecord,
): Promise<void> {
	const result = await client.session.promptAsync({
		path: { id: task.child_session_id },
		body: {
			agent: task.agent,
			parts: [{ type: "text", text: task.prompt }],
		},
	});

	if (result.error) {
		throw new Error(String(result.error));
	}
}

async function promoteRunnableTasks(
	client: DelegationClient,
	state: TaskStateManager,
): Promise<void> {
	const blocked = await state.listRunnableBlockedTasks({ limit: 100 });
	const queued = await state.listRunnableQueuedTasks(100);
	const candidates = [...blocked, ...queued].sort((a, b) =>
		a.created_at.localeCompare(b.created_at),
	);

	for (const task of candidates) {
		if (!task.run_in_background) continue;

		const concurrencyKey = task.concurrency_key ?? task.agent;
		const running = await getRunningCount(state, concurrencyKey);
		if (running >= MAX_RUNNING_PER_AGENT) continue;

		try {
			await startTaskSession(client, task);
			await state.transitionTask(task.id, "running");
		} catch (error) {
			await state.transitionTask(task.id, "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return;
}

async function getLatestAssistantResult(
	client: DelegationClient,
	sessionID: string,
): Promise<string | null> {
	const response = await client.session.messages({
		path: { id: sessionID },
		query: { limit: 40 },
	});
	return extractLatestAssistantText(response.data);
}

async function getSessionStatus(
	client: DelegationClient,
	sessionID: string,
): Promise<string | undefined> {
	if (!client.session.status) return undefined;

	const result = await client.session.status({
		path: { id: sessionID },
	});
	if (!result.data || typeof result.data !== "object") return undefined;

	const data = result.data as Record<string, unknown>;
	const direct = data[sessionID];
	if (direct && typeof direct === "object") {
		const directRecord = direct as Record<string, unknown>;
		if (typeof directRecord.type === "string") {
			return directRecord.type;
		}
	}

	if (typeof data.type === "string") {
		return data.type;
	}

	return undefined;
}

async function refreshTaskFromRuntime(
	client: DelegationClient,
	state: TaskStateManager,
	task: TaskRecord,
): Promise<TaskRecord> {
	if (task.status !== "running") return task;

	const status = await getSessionStatus(client, task.child_session_id);
	if (status === "idle") {
		const result = await getLatestAssistantResult(
			client,
			task.child_session_id,
		);
		return state.transitionTask(task.id, "succeeded", {
			result: result ?? undefined,
		});
	}

	if (status === "error") {
		return state.transitionTask(task.id, "failed", {
			error: "Task session reported an error.",
		});
	}

	return task;
}

async function resolveTaskByHandle(
	state: TaskStateManager,
	handle: string,
): Promise<TaskRecord | null> {
	const trimmed = handle.trim();
	if (!trimmed) return null;
	return state.getTask(trimmed);
}

async function resolveScopedTask(
	client: DelegationClient,
	state: TaskStateManager,
	handle: string,
	toolCtx: DelegationToolContext,
): Promise<TaskRecord | null> {
	if (!toolCtx.sessionID) {
		throw new Error("sessionID is required for task resolution.");
	}

	const task = await resolveTaskByHandle(state, handle);
	if (!task) return null;

	const rootSessionID = await getRootSessionID(client, toolCtx.sessionID);
	if (task.root_session_id !== rootSessionID) {
		return null;
	}

	return task;
}

async function askForTaskPermission(
	toolCtx: DelegationToolContext,
	input: {
		description: string;
		agent: string;
		category?: DelegationCategory;
		auto_route: boolean;
	},
): Promise<void> {
	if (!toolCtx.ask) return;

	await toolCtx.ask({
		permission: "task",
		patterns: [input.agent],
		always: ["*"],
		metadata: {
			description: input.description,
			subagent_type: input.agent,
			auto_route: input.auto_route,
			...(input.category ? { category: input.category } : {}),
		},
	});
}

export const DelegationPlugin: Plugin = async (ctx: {
	directory: string;
	client: unknown;
}) => {
	const workspaceDir = join(ctx.directory, ".opencode", "workspace");
	await mkdir(workspaceDir, { recursive: true });

	const client = ctx.client as unknown as DelegationClient;
	const sink = async (entry: {
		service: string;
		level: string;
		message: string;
		extra?: Record<string, unknown>;
	}) => {
		await client.app?.log?.({
			body: entry,
		});
	};
	const logger = createLogger("delegation.plugin", sink);
	const state = createTaskStateManager(
		workspaceDir,
		createLogger("delegation.state", sink),
	);
	const toolMetadata = createToolMetadataStore();

	const event = async (payload: { event?: unknown }) => {
		let taskID: string | null = null;
		try {
			if (!payload.event || typeof payload.event !== "object") return;

			const runtimeEvent = payload.event as RuntimeEvent;
			if (
				runtimeEvent.type !== "session.idle" &&
				runtimeEvent.type !== "session.error" &&
				runtimeEvent.type !== "session.deleted" &&
				runtimeEvent.type !== "session.interrupt"
			) {
				return;
			}

			const sessionID = getEventSessionID(runtimeEvent);
			if (!sessionID) return;

			const task = await state.getTaskByChildSessionID(sessionID);
			if (!task || task.status !== "running") return;
			taskID = task.id;

			if (runtimeEvent.type === "session.idle") {
				const result = await getLatestAssistantResult(client, sessionID);
				await state.transitionTask(task.id, "succeeded", {
					result: result ?? undefined,
				});
				await promoteRunnableTasks(client, state);
				return;
			}

			if (runtimeEvent.type === "session.error") {
				await state.transitionTask(task.id, "failed", {
					error: getEventError(runtimeEvent),
				});
				await promoteRunnableTasks(client, state);
				return;
			}

			await state.transitionTask(task.id, "cancelled", {
				error:
					runtimeEvent.type === "session.interrupt"
						? "Task session interrupted."
						: "Task session deleted.",
			});
			await promoteRunnableTasks(client, state);
		} catch (error) {
			if (taskID) {
				const current = await state.getTask(taskID).catch(() => null);
				if (
					current &&
					(current.status === "cancelled" ||
						current.status === "failed" ||
						current.status === "succeeded")
				) {
					return;
				}
			}

			logger.warn("Task event handling failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const toolExecuteAfter = async (
		input: DelegationToolExecuteAfterInput,
		output: DelegationToolResult | undefined,
	) => {
		if (!output) return;

		const stored = toolMetadata.consumeToolMetadata(
			input.sessionID,
			input.callID,
		);
		if (!stored) return;

		mergeToolMetadata(output, stored);
	};

	return {
		event,
		"tool.execute.after": toolExecuteAfter,
		tool: {
			task: tool({
				description:
					"Launch a subagent task, optionally run it in the background, and return a durable task id plus child session metadata.",
				args: {
					description: tool.schema
						.string()
						.describe("A short (3-5 words) description of the task"),
					prompt: tool.schema
						.string()
						.describe("The task for the agent to perform"),
					subagent_type: tool.schema
						.string()
						.optional()
						.describe("The type of specialized agent to use for this task"),
					task_id: tool.schema
						.string()
						.optional()
						.describe("Optional durable task id to continue a prior task."),
					command: tool.schema
						.string()
						.optional()
						.describe("The command that triggered this task"),
					run_in_background: tool.schema
						.boolean()
						.optional()
						.describe(
							"Run asynchronously and inspect later with background_output (default: false).",
						),
					category: tool.schema
						.string()
						.optional()
						.describe("Optional routing category for default-agent selection."),
					auto_route: tool.schema
						.boolean()
						.optional()
						.describe(
							"Enable keyword-based agent routing when subagent_type is omitted.",
						),
				},
				async execute(rawArgs: unknown, rawToolCtx: unknown) {
					const args = rawArgs as TaskToolArgs;
					const toolCtx = rawToolCtx as DelegationToolContext;

					if (!toolCtx.sessionID) {
						return "❌ task requires sessionID. This is a system error.";
					}

					const description = args.description.trim();
					const prompt = args.prompt.trim();
					if (!description) return "❌ description is required.";
					if (!prompt) return "❌ prompt is required.";

					const runInBackground = args.run_in_background === true;
					const requestedTaskID = args.task_id?.trim();
					const requestedCategory = parseDelegationCategory(
						args.category?.trim(),
					);
					const autoRoute = args.auto_route === true;

					let agent = args.subagent_type?.trim() ?? "";
					let category: DelegationCategory | undefined;
					let routing: DelegationRoutingTelemetry | undefined;

					if (!agent) {
						if (!requestedCategory && !autoRoute) {
							return "❌ Provide subagent_type, or set category/auto_route for routed execution.";
						}

						const decision = resolveDelegationRouting({
							description,
							prompt,
							command: args.command?.trim(),
							category: requestedCategory ?? undefined,
							autoRoute,
						});
						agent = decision.agent;
						category = decision.telemetry.detected_category;
						routing = decision.telemetry;
					} else if (requestedCategory) {
						category = requestedCategory;
						routing = {
							detected_category: requestedCategory,
							chosen_agent: agent,
							confidence: 1,
							fallback_path: "user-subagent",
						};
					}

					await askForTaskPermission(toolCtx, {
						description,
						agent,
						category,
						auto_route: autoRoute,
					});

					const rootSessionID = await getRootSessionID(
						client,
						toolCtx.sessionID,
					);
					const concurrencyKey = agent;

					let childSessionID: string | null = null;
					let task: TaskRecord;

					if (requestedTaskID) {
						const existing = await resolveScopedTask(
							client,
							state,
							requestedTaskID,
							toolCtx,
						);
						if (existing) {
							if (isActiveTask(existing.status)) {
								return `❌ Task ${existing.id} is already active.`;
							}

							task = await state.restartTask({
								id: existing.id,
								description,
								prompt,
								command: args.command?.trim(),
								category,
								routing,
								concurrency_key: concurrencyKey,
								run_in_background: runInBackground,
								initial_status: runInBackground ? "queued" : "running",
							});
							childSessionID = task.child_session_id;
						} else {
							return `❌ Task not found: ${requestedTaskID}`;
						}
					} else {
						const session = await client.session.create({
							body: {
								title: `${description} (@${agent} task)`,
								parentID: toolCtx.sessionID,
							},
						});
						childSessionID = getSessionIDFromCreateResponse(session.data);
						if (!childSessionID) {
							return "❌ Failed to create child session for task.";
						}

						const taskID = await generateTaskID(state);
						task = await state.createTask({
							id: taskID,
							root_session_id: rootSessionID,
							parent_session_id: toolCtx.sessionID,
							child_session_id: childSessionID,
							description,
							agent,
							prompt,
							command: args.command?.trim(),
							category,
							routing,
							concurrency_key: concurrencyKey,
							run_in_background: runInBackground,
							initial_status: runInBackground ? "queued" : "running",
						});
					}

					await emitToolMetadata(toolCtx, toolMetadata, {
						title: description,
						metadata: {
							taskId: task.id,
							reference: `ref:${task.id}`,
							sessionId: task.child_session_id,
							agent,
							runInBackground,
							...(category ? { category } : {}),
						},
					});

					if (runInBackground) {
						await promoteRunnableTasks(client, state);
						const latest = (await state.getTask(task.id)) ?? task;
						return formatBackgroundLaunch(latest);
					}

					try {
						const response = await client.session.prompt({
							path: { id: task.child_session_id },
							body: {
								agent,
								parts: [{ type: "text", text: prompt }],
							},
						});
						if (response.error) {
							const failed = await state.transitionTask(task.id, "failed", {
								error: String(response.error),
							});
							return `❌ Task failed.\n\n${formatTaskStatus(failed)}`;
						}

						const resultText =
							extractPromptResponseText(response.data) ??
							(await getLatestAssistantResult(client, task.child_session_id)) ??
							"";
						const succeeded = await state.transitionTask(task.id, "succeeded", {
							result: resultText || undefined,
						});
						return formatSyncCompletion(succeeded, resultText);
					} catch (error) {
						const failed = await state.transitionTask(task.id, "failed", {
							error: error instanceof Error ? error.message : String(error),
						});
						return `❌ Task failed.\n\n${formatTaskStatus(failed)}`;
					}
				},
			}),

			background_output: tool({
				description:
					"Read the latest status or transcript for a background task using its durable task id.",
				args: {
					task_id: tool.schema.string().describe("Durable task id."),
					block: tool.schema
						.boolean()
						.optional()
						.describe("Wait for completion before returning output."),
					timeout: tool.schema
						.number()
						.optional()
						.describe(
							"Maximum time to wait when block=true (default: 60000ms).",
						),
					full_session: tool.schema
						.boolean()
						.optional()
						.describe(
							"Return the recent session transcript instead of summary status.",
						),
					include_thinking: tool.schema
						.boolean()
						.optional()
						.describe("Include reasoning parts in full_session output."),
					include_tool_results: tool.schema
						.boolean()
						.optional()
						.describe("Include tool outputs in full_session output."),
					message_limit: tool.schema
						.number()
						.optional()
						.describe("Maximum number of messages to include."),
				},
				async execute(rawArgs: unknown, rawToolCtx: unknown) {
					const args = rawArgs as BackgroundOutputArgs;
					const toolCtx = rawToolCtx as DelegationToolContext;
					const task = await resolveScopedTask(
						client,
						state,
						args.task_id,
						toolCtx,
					).catch(
						(error) =>
							`❌ ${error instanceof Error ? error.message : String(error)}`,
					);

					if (typeof task === "string") return task;
					if (!task) return `❌ Task not found: ${args.task_id}`;

					await emitToolMetadata(toolCtx, toolMetadata, {
						title: task.description,
						metadata: {
							taskId: task.id,
							reference: `ref:${task.id}`,
							sessionId: task.child_session_id,
							agent: task.agent,
						},
					});

					let current = task;
					if (args.block === true) {
						const timeoutMs = Math.min(
							Math.max(
								1000,
								Math.floor(args.timeout ?? DEFAULT_BLOCK_TIMEOUT_MS),
							),
							10 * 60 * 1000,
						);
						const deadline = Date.now() + timeoutMs;
						while (isActiveTask(current.status) && Date.now() < deadline) {
							current = await refreshTaskFromRuntime(client, state, current);
							if (!isActiveTask(current.status)) break;
							await sleep(1000);
							const latest = await state.getTask(current.id);
							if (latest) current = latest;
						}
					}

					if (args.full_session !== false) {
						const response = await client.session.messages({
							path: { id: current.child_session_id },
							query: { limit: args.message_limit },
						});
						return formatFullSession(response.data, {
							task: current,
							includeThinking: args.include_thinking,
							includeToolResults: args.include_tool_results,
							messageLimit: args.message_limit,
						});
					}

					if (current.status === "succeeded" && current.result) {
						return formatSyncCompletion(current, current.result);
					}

					return formatTaskStatus(current);
				},
			}),

			background_cancel: tool({
				description:
					"Cancel one active background task by durable task id, or cancel all active background tasks in the current root session.",
				args: {
					task_id: tool.schema
						.string()
						.optional()
						.describe("Durable task id to cancel."),
					all: tool.schema
						.boolean()
						.optional()
						.describe(
							"Cancel all active background tasks in the current root session.",
						),
					reason: tool.schema
						.string()
						.optional()
						.describe("Optional cancellation reason."),
				},
				async execute(rawArgs: unknown, rawToolCtx: unknown) {
					const args = rawArgs as BackgroundCancelArgs;
					const toolCtx = rawToolCtx as DelegationToolContext;
					if (!toolCtx.sessionID) {
						return "❌ background_cancel requires sessionID. This is a system error.";
					}

					const rootSessionID = await getRootSessionID(
						client,
						toolCtx.sessionID,
					);
					const approvalBlocked = await enforceToolApproval({
						directory: ctx.directory,
						rootSessionID,
						toolName: "background_cancel",
						reason:
							args.all === true
								? "Cancel all active background tasks in the current root session."
								: `Cancel background task '${args.task_id?.trim() || ""}'.`,
						ask: toolCtx.ask,
					});
					if (approvalBlocked) {
						return approvalBlocked;
					}

					const reasonText = args.reason?.trim();
					if (args.all === true) {
						const tasks = await state.listTasks({
							root_session_id: rootSessionID,
							limit: 500,
							run_in_background: true,
						});
						const active = tasks.filter((task) => isActiveTask(task.status));
						if (active.length === 0) {
							return "No active background tasks to cancel.";
						}

						const cancelled: TaskRecord[] = [];
						for (const task of active) {
							if (task.status === "running") {
								await client.session
									.abort({
										path: { id: task.child_session_id },
									})
									.catch(() => undefined);
							}
							cancelled.push(
								await state.transitionTask(task.id, "cancelled", {
									error: reasonText
										? `Cancelled: ${reasonText}`
										: "Task cancelled by user request.",
								}),
							);
						}

						await promoteRunnableTasks(client, state);
						return [
							`Cancelled ${cancelled.length} background task(s):`,
							...cancelled.map(
								(task) =>
									`- ${task.id} (${task.agent}) -> ${task.child_session_id}`,
							),
						].join("\n");
					}

					const handle = args.task_id?.trim();
					if (!handle) {
						return "❌ Provide task_id, or set all=true.";
					}

					const task = await resolveScopedTask(client, state, handle, toolCtx);
					if (!task) return `❌ Task not found: ${handle}`;
					if (!isActiveTask(task.status)) return formatTaskStatus(task);

					if (task.status === "running") {
						await client.session
							.abort({
								path: { id: task.child_session_id },
							})
							.catch(() => undefined);
					}

					const cancelled = await state.transitionTask(task.id, "cancelled", {
						error: reasonText
							? `Cancelled: ${reasonText}`
							: "Task cancelled by user request.",
					});
					await promoteRunnableTasks(client, state);
					return formatTaskStatus(cancelled);
				},
			}),

			agent_status: tool({
				description:
					"Read-only health summary for current root session using background-task signals (healthy|degraded|stuck).",
				args: {
					stuck_after_ms: tool.schema.number().int().min(1000).optional(),
					queue_degraded_after_ms: tool.schema
						.number()
						.int()
						.min(1000)
						.optional(),
					failure_window_ms: tool.schema.number().int().min(1000).optional(),
					limit: tool.schema.number().int().min(1).max(300).optional(),
				},
				async execute(args: unknown, rawToolCtx: unknown) {
					const toolCtx = rawToolCtx as DelegationToolContext;
					if (!toolCtx.sessionID) {
						return "❌ agent_status requires sessionID. This is a system error.";
					}

					const rootSessionID = await getRootSessionID(
						client,
						toolCtx.sessionID,
					);
					const tasks = await state.listTasks({
						root_session_id: rootSessionID,
						limit: (args as { limit?: number }).limit ?? 100,
					});
					const snapshot = summarizeAgentStatus(tasks, {
						nowMs: Date.now(),
						stuckAfterMs: (args as { stuck_after_ms?: number }).stuck_after_ms,
						queueDegradedAfterMs: (args as { queue_degraded_after_ms?: number })
							.queue_degraded_after_ms,
						failureWindowMs: (args as { failure_window_ms?: number })
							.failure_window_ms,
					});

					return JSON.stringify(
						{
							root_session_id: rootSessionID,
							...snapshot,
						},
						null,
						2,
					);
				},
			}),

			task_graph_status: tool({
				description:
					"Inspect task graph status with blocked-task metadata for durable delegation records.",
				args: {
					root_session_id: tool.schema.string().optional(),
					include_completed: tool.schema.boolean().optional(),
					limit: tool.schema.number().int().min(1).max(500).optional(),
				},
				async execute(args: unknown, rawToolCtx: unknown) {
					const toolCtx = rawToolCtx as DelegationToolContext;
					const input = args as {
						root_session_id?: string;
						include_completed?: boolean;
						limit?: number;
					};

					if (!input.root_session_id && !toolCtx.sessionID) {
						return "❌ task_graph_status requires sessionID when root_session_id is omitted.";
					}

					const rootSessionID = input.root_session_id
						? input.root_session_id
						: await getRootSessionID(client, toolCtx.sessionID);
					const tasks = await state.listTasks({
						root_session_id: rootSessionID,
						limit: input.limit ?? 200,
					});
					const graph = buildTaskGraph(tasks, {
						includeCompleted: input.include_completed ?? true,
					});

					return JSON.stringify(
						{
							root_session_id: rootSessionID,
							...graph,
						},
						null,
						2,
					);
				},
			}),
		},
	};
};

export default DelegationPlugin;

export type {
	AgentHealthStatus,
	AgentStatusEvidence,
} from "./agent-status.js";
export type {
	TaskRecord,
	TaskStateManager,
	TaskStatus,
} from "./state.js";
export type {
	TaskGraphEdge,
	TaskGraphNode,
	TaskGraphSnapshot,
} from "./task-graph.js";
