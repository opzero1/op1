import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat.js";
import { DelegationPlugin } from "../index.js";

let tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
});

function createMockClient() {
	const sessionParents: Record<string, string | undefined> = {
		"parent-session": undefined,
	};
	let status = "running";
	let childCount = 0;
	let promptAsyncCalls = 0;

	return {
		app: {
			agents: async () => ({
				data: [{ name: "explore", mode: "subagent" }],
			}),
		},
		session: {
			get: async (input: { path: { id: string } }) => ({
				data: {
					id: input.path.id,
					...(sessionParents[input.path.id]
						? { parentID: sessionParents[input.path.id] }
						: {}),
				},
			}),
			create: async () => {
				childCount += 1;
				const id = `child-session-${childCount}`;
				sessionParents[id] = "parent-session";
				return { data: { id } };
			},
			prompt: async () => ({
				data: { parts: [{ type: "text", text: "sync result" }] },
			}),
			promptAsync: async () => {
				promptAsyncCalls += 1;
				return { data: {} };
			},
			messages: async () => ({
				data: [
					{
						id: "msg-1",
						info: {
							role: "assistant",
							time: { created: "2026-03-06T00:00:00.000Z" },
						},
						parts: [{ type: "text", text: "background result" }],
					},
				],
			}),
			abort: async () => ({}),
			status: async () => ({
				data: {
					...Object.fromEntries(
						Object.keys(sessionParents)
							.filter((id) => id.startsWith("child-session-"))
							.map((id) => [id, { type: status }]),
					),
				},
			}),
		},
		setStatus(next: string) {
			status = next;
		},
		getPromptAsyncCalls() {
			return promptAsyncCalls;
		},
	};
}

type ToolExecute = (args: unknown, toolCtx: unknown) => Promise<string>;
type ToolExecuteAfter = (
	input: { tool: string; sessionID: string; callID: string; args?: unknown },
	output: { title: string; output: string; metadata: Record<string, unknown> },
) => Promise<void>;

describe("delegation plugin", () => {
	test("publishes a literal task tool id for OpenCode override wiring", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-tool-id-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = (await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never)) as unknown as {
			tool?: Record<string, unknown>;
			"tool.execute.after"?: unknown;
		};

		const tools = plugin.tool ?? {};
		expect(Object.keys(tools)).toContain("task");
		expect(plugin["tool.execute.after"]).toBeDefined();

		const promptTimeMap: Record<string, unknown> = {
			task: "builtin-task",
		};
		for (const [id, value] of Object.entries(tools)) {
			promptTimeMap[id] = value;
		}

		expect(promptTimeMap.task).toBe(tools.task);
	});

	test("restores final task metadata through tool.execute.after", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-final-meta-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = (await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never)) as unknown as {
			tool?: Record<string, unknown>;
			"tool.execute.after"?: unknown;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const afterHook = plugin["tool.execute.after"] as ToolExecuteAfter;
		const result = await taskTool.execute(
			{
				description: "Explore code",
				prompt: "Inspect the repository",
				subagent_type: "explore",
			},
			{
				sessionID: "parent-session",
				callID: "call-1",
				ask: async () => {},
				metadata: async () => {},
			},
		);

		const output: {
			title: string;
			output: string;
			metadata: {
				truncated: boolean;
				sessionId?: string;
				taskId?: string;
			};
		} = {
			title: "",
			output: result,
			metadata: { truncated: false },
		};
		await afterHook(
			{ tool: "task", sessionID: "parent-session", callID: "call-1" },
			output,
		);

		expect(output.title).toBe("Explore code");
		expect(output.metadata.sessionId).toBe("child-session-1");
		expect(output.metadata.taskId).toBeDefined();
		expect(output.metadata.truncated).toBe(false);
	});

	test("launches background task with metadata.sessionId", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-plugin-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const client = createMockClient();
		const plugin = await DelegationPlugin({
			directory: root,
			client,
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const metadataCalls: Array<{ metadata?: Record<string, unknown> }> = [];
		const result = await taskTool.execute(
			{
				description: "Explore code",
				prompt: "Inspect the repository",
				subagent_type: "explore",
				run_in_background: true,
			},
			{
				sessionID: "parent-session",
				callID: "call-1",
				metadata: (input: { metadata?: Record<string, unknown> }) => {
					metadataCalls.push(input);
				},
				ask: async () => {},
			},
		);

		expect(result).toContain("Background task launched.");
		expect(result).toContain("Session ID: child-session-1");
		expect(
			metadataCalls.some(
				(call) => call.metadata?.sessionId === "child-session-1",
			),
		).toBe(true);

		const taskID = result.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		expect(taskID).toBeDefined();

		client.setStatus("idle");
		const output = await backgroundOutputTool.execute(
			{
				task_id: taskID,
				block: true,
				full_session: false,
			},
			{ sessionID: "parent-session" },
		);

		expect(output).toContain("Task completed.");
		expect(output).toContain("background result");
	});

	test("keeps tasks queued once per-agent background concurrency is saturated", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-queue-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as {
			execute: (args: unknown, toolCtx: unknown) => Promise<string>;
		};
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: (args: unknown, toolCtx: unknown) => Promise<string>;
		};

		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				taskTool.execute(
					{
						description: `Explore ${index}`,
						prompt: `Inspect target ${index}`,
						subagent_type: "explore",
						run_in_background: true,
					},
					{
						sessionID: "parent-session",
						ask: async () => {},
					},
				),
			),
		);

		const lastTaskID = results[5]?.match(
			/Task ID: ([a-z]+-[a-z]+-[a-z]+)/,
		)?.[1];
		const output = await backgroundOutputTool.execute(
			{
				task_id: lastTaskID,
				full_session: false,
			},
			{ sessionID: "parent-session" },
		);

		expect(lastTaskID).toBeDefined();
		expect(output).toContain("Status: queued");
	});

	test("cancels an active background task by durable task id", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-cancel-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as {
			execute: (args: unknown, toolCtx: unknown) => Promise<string>;
		};
		const cancelTool = plugin.tool?.background_cancel as {
			execute: (args: unknown, toolCtx: unknown) => Promise<string>;
		};

		const launched = await taskTool.execute(
			{
				description: "Explore code",
				prompt: "Inspect the repository",
				subagent_type: "explore",
				run_in_background: true,
			},
			{
				sessionID: "parent-session",
				ask: async () => {},
			},
		);

		const taskID = launched.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const cancelled = await cancelTool.execute(
			{
				task_id: taskID,
				reason: "No longer needed",
			},
			{ sessionID: "parent-session" },
		);

		expect(taskID).toBeDefined();
		expect(cancelled).toContain("Status: cancelled");
		expect(cancelled).toContain("Cancelled: No longer needed");
	});

	test("runs sync task and returns durable task metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-sync-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as {
			execute: (args: unknown, toolCtx: unknown) => Promise<string>;
		};

		const result = await taskTool.execute(
			{
				description: "Fix type error",
				prompt: "Resolve the broken type",
				subagent_type: "explore",
			},
			{
				sessionID: "parent-session",
				ask: async () => {},
			},
		);

		expect(result).toContain("Task completed.");
		expect(result).toContain("sync result");
		expect(result).toContain("<task_metadata>");
	});

	test("auto-restarts background autoloop tasks after success when stop conditions stay open", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-autoloop-"));
		tempRoots.push(root);
		const workspaceDir = join(root, ".opencode", "workspace");
		await mkdir(workspaceDir, { recursive: true });
		const autoloopDir = join(workspaceDir, "autoloop", "agent-harness");
		await mkdir(autoloopDir, { recursive: true });
		await Bun.write(
			join(autoloopDir, "state.jsonl"),
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
					slug: "agent-harness",
					max_iterations: 50,
				}),
				JSON.stringify({
					type: "iteration",
					iteration: 26,
					timestamp: "2026-03-19T00:10:00Z",
					action: "Made progress",
					status: "passed",
					outcome: "keep",
					next_step: "Keep going",
				}),
			].join("\n"),
		);

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};
		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const launched = await taskTool.execute(
			{
				description: "Autoloop worker",
				prompt:
					"Recover .opencode/workspace/autoloop/agent-harness/ and continue the loop.",
				subagent_type: "build",
				command: "autoloop:agent-harness@25",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(launched).toContain("Background task launched.");
		expect(client.getPromptAsyncCalls()).toBe(1);

		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		expect(client.getPromptAsyncCalls()).toBe(2);
		const taskRecords = JSON.parse(
			await Bun.file(join(workspaceDir, "task-records.json")).text(),
		) as {
			delegations: Record<string, { status: string; command?: string }>;
		};
		const task = Object.values(taskRecords.delegations)[0];
		expect(task.status).toBe("running");
		expect(task.command).toBe("autoloop:agent-harness@26");
	});

	test("does not auto-restart autoloop tasks when paused or continuation is stopped", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-autoloop-stop-"));
		tempRoots.push(root);
		const workspaceDir = join(root, ".opencode", "workspace");
		await mkdir(workspaceDir, { recursive: true });
		const autoloopDir = join(workspaceDir, "autoloop", "agent-harness");
		await mkdir(autoloopDir, { recursive: true });
		await Bun.write(join(autoloopDir, ".paused"), "");
		await Bun.write(
			join(workspaceDir, "continuation.json"),
			JSON.stringify(
				{
					sessions: {
						"parent-session": {
							session_id: "parent-session",
							mode: "stopped",
							updated_at: "2026-03-19T00:00:00Z",
						},
					},
				},
				null,
				2,
			),
		);
		await Bun.write(
			join(autoloopDir, "state.jsonl"),
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
					slug: "agent-harness",
					max_iterations: 50,
				}),
				JSON.stringify({
					type: "iteration",
					iteration: 26,
					timestamp: "2026-03-19T00:10:00Z",
					action: "Made progress",
					status: "passed",
					outcome: "keep",
					next_step: "Keep going",
				}),
			].join("\n"),
		);

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};
		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		await taskTool.execute(
			{
				description: "Autoloop worker",
				prompt:
					"Recover .opencode/workspace/autoloop/agent-harness/ and continue the loop.",
				subagent_type: "build",
				command: "autoloop:agent-harness@25",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		expect(client.getPromptAsyncCalls()).toBe(1);
		const taskRecords = JSON.parse(
			await Bun.file(join(workspaceDir, "task-records.json")).text(),
		) as {
			delegations: Record<string, { status: string; command?: string }>;
		};
		const task = Object.values(taskRecords.delegations)[0];
		expect(task.status).toBe("succeeded");
		expect(task.command).toBe("autoloop:agent-harness@25");
	});
});
