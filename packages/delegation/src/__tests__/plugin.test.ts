import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat.js";
import { DelegationPlugin } from "../index.js";
import { createTaskStateManager } from "../state.js";

let tempRoots: string[] = [];

async function runCommand(command: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || command.join(" "));
	}
	return stdout.trim();
}

async function initializeGitRepo(
	root: string,
	options?: { packageJson?: string },
): Promise<void> {
	await runCommand(["git", "init", "-b", "main"], root);
	await Bun.write(join(root, "README.md"), "# test repo\n");
	if (options?.packageJson) {
		await Bun.write(join(root, "package.json"), options.packageJson);
	}
	await runCommand(["git", "add", "."], root);
	await runCommand(
		[
			"git",
			"-c",
			"user.name=Op1 Test",
			"-c",
			"user.email=op1@example.com",
			"commit",
			"-m",
			"init",
		],
		root,
	);
}

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
});

function createMockClient(options?: {
	failPromptAsyncOnRepeat?: boolean;
	availableAgents?: Array<{ name: string; mode: string }>;
	createResponseShape?: "flat" | "nested-session" | "session-id";
	statusResponseShape?: "indexed-type" | "direct-type" | "direct-status";
	sessionParentKey?: "parentID" | "parentId" | "parent_id";
	sessionMessages?: Record<string, unknown[]>;
}) {
	const sessionParents: Record<string, string | undefined> = {
		"parent-session": undefined,
	};
	const sessionStatuses: Record<string, string> = {};
	const promptAsyncSessionCounts: Record<string, number> = {};
	const promptedSessionIDs: string[] = [];
	const availableAgents =
		options?.availableAgents ??
		([
			{ name: "build", mode: "primary" },
			{ name: "coder", mode: "subagent" },
			{ name: "frontend", mode: "subagent" },
			{ name: "oracle", mode: "subagent" },
			{ name: "reviewer", mode: "subagent" },
			{ name: "researcher", mode: "subagent" },
			{ name: "explore", mode: "subagent" },
		] satisfies Array<{ name: string; mode: string }>);
	let defaultStatus = "running";
	let childCount = 0;
	let promptAsyncCalls = 0;
	const promptAsyncRequests: Array<{
		sessionID: string;
		agent?: string;
		text?: string;
	}> = [];
	const createdSessionDirectories: Array<string | undefined> = [];
	const sessionMessages: Record<string, unknown[]> = {
		...(options?.sessionMessages ?? {}),
	};

	const sessionParentKey = options?.sessionParentKey ?? "parentID";
	const createResponseShape = options?.createResponseShape ?? "flat";
	const statusResponseShape = options?.statusResponseShape ?? "indexed-type";

	return {
		app: {
			agents: async () => ({
				data: availableAgents,
			}),
		},
		session: {
			get: async (input: { path: { id: string } }) => ({
				data: {
					id: input.path.id,
					...(sessionParents[input.path.id]
						? { [sessionParentKey]: sessionParents[input.path.id] }
						: {}),
				},
			}),
			create: async (input?: { query?: { directory?: string } }) => {
				childCount += 1;
				const id = `child-session-${childCount}`;
				createdSessionDirectories.push(input?.query?.directory);
				sessionParents[id] = "parent-session";
				sessionStatuses[id] = defaultStatus;
				sessionMessages[id] ??= [
					{
						id: "msg-1",
						info: {
							role: "assistant",
							time: { created: "2026-03-06T00:00:00.000Z" },
						},
						parts: [{ type: "text", text: "background result" }],
					},
				];
				if (createResponseShape === "nested-session") {
					return { data: { session: { id } } };
				}
				if (createResponseShape === "session-id") {
					return { data: { sessionID: id } };
				}
				return { data: { id } };
			},
			prompt: async () => ({
				data: { parts: [{ type: "text", text: "sync result" }] },
			}),
			promptAsync: async (input: {
				path: { id: string };
				body?: {
					agent?: string;
					parts?: Array<{ type?: string; text?: string }>;
				};
			}) => {
				const sessionID = input.path.id;
				const seenCount = promptAsyncSessionCounts[sessionID] ?? 0;
				if (options?.failPromptAsyncOnRepeat === true && seenCount > 0) {
					return { error: `Session not found: ${sessionID}` };
				}

				promptAsyncSessionCounts[sessionID] = seenCount + 1;
				promptedSessionIDs.push(sessionID);
				const firstPart = input.body?.parts?.[0];
				promptAsyncRequests.push({
					sessionID,
					agent: input.body?.agent,
					text:
						firstPart?.type === "text" && typeof firstPart.text === "string"
							? firstPart.text
							: undefined,
				});
				promptAsyncCalls += 1;
				return { data: {} };
			},
			messages: async (input: { path: { id: string } }) => ({
				data: sessionMessages[input.path.id] ?? [],
			}),
			abort: async () => ({}),
			status: async (input: { path: { id: string } }) => {
				if (statusResponseShape === "direct-type") {
					return {
						data: { type: sessionStatuses[input.path.id] ?? defaultStatus },
					};
				}
				if (statusResponseShape === "direct-status") {
					return {
						data: { status: sessionStatuses[input.path.id] ?? defaultStatus },
					};
				}

				return {
					data: {
						...Object.fromEntries(
							Object.keys(sessionParents)
								.filter((id) => id.startsWith("child-session-"))
								.map((id) => [
									id,
									{ type: sessionStatuses[id] ?? defaultStatus },
								]),
						),
					},
				};
			},
		},
		setStatus(next: string) {
			defaultStatus = next;
			for (const sessionID of Object.keys(sessionStatuses)) {
				sessionStatuses[sessionID] = next;
			}
		},
		setSessionStatus(sessionID: string, next: string) {
			sessionStatuses[sessionID] = next;
		},
		getPromptAsyncCalls() {
			return promptAsyncCalls;
		},
		getPromptedSessionIDs() {
			return [...promptedSessionIDs];
		},
		getPromptAsyncRequests() {
			return [...promptAsyncRequests];
		},
		getCreatedSessionDirectories() {
			return [...createdSessionDirectories];
		},
		setMessages(sessionID: string, messages: unknown[]) {
			sessionMessages[sessionID] = messages;
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
				reference?: string;
				task?: {
					task_id: string;
					session_id: string;
					status: string;
				};
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
		expect(output.metadata.reference).toBe(`ref:${output.metadata.taskId}`);
		expect(output.metadata.task?.task_id).toBe(output.metadata.taskId);
		expect(output.metadata.task?.session_id).toBe(output.metadata.sessionId);
		expect(output.metadata.task?.status).toBe("succeeded");
		expect(output.output).toContain("Task completed.");
		expect(output.metadata.truncated).toBe(false);
	});

	test("launches background task with metadata.sessionId", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-plugin-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			"tool.execute.after"?: ToolExecuteAfter;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};
		const afterHook = plugin["tool.execute.after"] as ToolExecuteAfter;

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
				callID: "launch-call",
				metadata: (input: { metadata?: Record<string, unknown> }) => {
					metadataCalls.push(input);
				},
				ask: async () => {},
			},
		);

		const launchOutput: {
			title: string;
			output: string;
			metadata: {
				truncated: boolean;
				taskId?: string;
				task?: {
					status: string;
					run_in_background: boolean;
				};
			};
		} = {
			title: "",
			output: result,
			metadata: { truncated: false },
		};
		await afterHook(
			{ tool: "task", sessionID: "parent-session", callID: "launch-call" },
			launchOutput,
		);

		expect(result).toContain("Background task launched.");
		expect(result).toContain("Session ID: child-session-1");
		expect(
			metadataCalls.some(
				(call) => call.metadata?.sessionId === "child-session-1",
			),
		).toBe(true);
		expect(launchOutput.metadata.task?.status).toBe("running");
		expect(launchOutput.metadata.task?.run_in_background).toBe(true);

		const taskID = result.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		expect(taskID).toBeDefined();

		client.setStatus("idle");
		const output = await backgroundOutputTool.execute(
			{
				task_id: taskID,
				block: true,
				full_session: false,
			},
			{ sessionID: "parent-session", callID: "status-call" },
		);
		const completedOutput: {
			title: string;
			output: string;
			metadata: {
				truncated: boolean;
				taskId?: string;
				task?: {
					task_id: string;
					status: string;
				};
			};
		} = {
			title: "",
			output,
			metadata: { truncated: false },
		};
		await afterHook(
			{
				tool: "background_output",
				sessionID: "parent-session",
				callID: "status-call",
			},
			completedOutput,
		);

		expect(output).toContain("Task completed.");
		expect(output).toContain("Status: succeeded");
		expect(output).toContain("background result");
		expect(completedOutput.metadata.task?.task_id).toBe(taskID);
		expect(completedOutput.metadata.task?.status).toBe("succeeded");
	});

	test("uses caller-provided task_id for a fresh task launch", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-custom-id-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};
		const state = createTaskStateManager(join(root, ".opencode", "workspace"));

		const launch = await taskTool.execute(
			{
				description: "Inspect runtime",
				prompt: "Find contract drift in delegation.",
				subagent_type: "explore",
				task_id: "task-runtime-1",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(launch).toContain("Background task launched.");
		expect(launch).toContain("Task ID: task-runtime-1");

		const output = await backgroundOutputTool.execute(
			{
				task_id: "task-runtime-1",
				full_session: false,
			},
			{ sessionID: "parent-session" },
		);

		expect(output).toContain("Task ID: task-runtime-1");
		expect(output).toContain("Status: running");
	});

	test("extracts inline authoritative context into durable task state", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "op1-delegation-inline-authctx-"),
		);
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const state = createTaskStateManager(join(root, ".opencode", "workspace"));

		const launch = await taskTool.execute(
			{
				description: "Inspect runtime",
				prompt:
					"Inspect README.md and stop\n\nAuthoritative context:\nTarget file: README.md",
				subagent_type: "explore",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		expect(taskID).toBeDefined();
		if (!taskID) throw new Error("Expected task id");

		const persisted = await state.getTask(taskID);
		expect(persisted?.authoritative_context).toBe("Target file: README.md");
		expect(persisted?.prompt).toBe("Inspect README.md and stop");
	});

	test("uses continue_task_id to restart an existing completed task", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-continue-id-"));
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
		const state = createTaskStateManager(join(root, ".opencode", "workspace"));

		const launch = await taskTool.execute(
			{
				description: "Inspect runtime",
				prompt: "Find contract drift in delegation.",
				subagent_type: "explore",
				task_id: "task-runtime-continue",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(launch).toContain("Task ID: task-runtime-continue");

		client.setStatus("idle");
		const firstTask = await backgroundOutputTool.execute(
			{
				task_id: "task-runtime-continue",
				block: true,
				full_session: false,
			},
			{ sessionID: "parent-session" },
		);
		const firstSessionID = firstTask.match(/Session ID: ([^\n]+)/)?.[1];
		expect(firstSessionID).toBeDefined();

		const completed = await taskTool.execute(
			{
				description: "Inspect runtime again",
				prompt: "Repeat the delegation inspection.",
				subagent_type: "explore",
				continue_task_id: "task-runtime-continue",
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(completed).toContain("Task completed.");
		expect(completed).toContain("Task ID: task-runtime-continue");
		const secondSessionID = completed.match(/Session ID: ([^\n]+)/)?.[1];
		expect(secondSessionID).toBeDefined();
		expect(secondSessionID).not.toBe(firstSessionID);
	});

	test("rejects mixing task_id and continue_task_id", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-mixed-id-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const output = await taskTool.execute(
			{
				description: "Inspect runtime",
				prompt: "Find contract drift in delegation.",
				subagent_type: "explore",
				task_id: "task-runtime-1",
				continue_task_id: "task-runtime-1",
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(output).toBe(
			"❌ Provide either task_id for a new launch or continue_task_id to resume an existing task, not both.",
		);
	});

	test("fails clearly when the requested agent is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-missing-agent-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient({
				availableAgents: [{ name: "explore", mode: "subagent" }],
			}),
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const output = await taskTool.execute(
			{
				description: "Frontend polish",
				prompt: "Polish the React settings page responsive states.",
				subagent_type: "frontend",
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(output).toContain("Agent 'frontend' is not available.");
		expect(output).toContain("explore (subagent)");
	});

	test("auto-routes frontend-owned prompts to the frontend agent", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-auto-route-fe-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const output = await taskTool.execute(
			{
				description: "Settings page polish",
				prompt:
					"Polish the React settings page responsive behavior and accessibility states.",
				auto_route: true,
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(output).toContain("Agent: frontend");
		expect(output).toContain("Task ID:");
	});

	test("reroutes explicit wrong-agent frontend requests to the frontend agent", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-reroute-fe-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const output = await taskTool.execute(
			{
				description: "Settings page polish",
				prompt:
					"Polish the React settings page responsive behavior and accessibility states.",
				subagent_type: "coder",
				auto_route: true,
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(output).toContain("Agent: frontend");
		expect(output).toContain("Task ID:");
	});

	test("launches eligible coding tasks in isolated worktrees for git repos", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-worktree-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root);

		const client = createMockClient();
		const plugin = await DelegationPlugin({
			directory: root,
			client,
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const output = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the requested helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		const createdDirectory = client.getCreatedSessionDirectories()[0];
		expect(output).toContain("Execution: worktree");
		expect(output).toContain("Branch: op1/coder/");
		expect(output).toContain("Worktree: ");
		expect(createdDirectory).toBeDefined();
		expect(createdDirectory).not.toBe(root);
		if (!createdDirectory) {
			throw new Error("Expected a created worktree directory");
		}
		expect(
			await runCommand(
				["git", "rev-parse", "--abbrev-ref", "HEAD"],
				createdDirectory,
			),
		).toContain("op1/coder/");
	});

	test("keeps read-only explore tasks on the direct execution path", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-direct-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root);

		const client = createMockClient();
		const plugin = await DelegationPlugin({
			directory: root,
			client,
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const output = await taskTool.execute(
			{
				description: "Inspect repo",
				prompt: "Find the delegation entrypoints.",
				subagent_type: "explore",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(output).toContain("Execution: direct");
		expect(client.getCreatedSessionDirectories()[0]).toBeUndefined();
	});

	test("blocks tiny delegated frontend tasks after six non-edit read/search/planning calls", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "op1-delegation-frontend-stale-"),
		);
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root);

		const client = createMockClient() as ReturnType<typeof createMockClient> & {
			setMessages: (sessionID: string, messages: unknown[]) => void;
		};
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Small /team page fix",
				prompt:
					"Update the /team page button spacing in packages/app/src/team/page.tsx.",
				subagent_type: "frontend",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		expect(taskID).toBeDefined();
		client.setMessages("child-session-1", [
			{
				id: "msg-1",
				info: {
					role: "assistant",
					time: { created: "2026-03-06T00:00:00.000Z" },
				},
				parts: [
					{ type: "tool", tool: "read", state: { output: "read" } },
					{ type: "tool", tool: "glob", state: { output: "glob" } },
					{ type: "tool", tool: "todowrite", state: { output: "todo" } },
					{ type: "tool", tool: "read", state: { output: "read" } },
					{ type: "tool", tool: "grep", state: { output: "grep" } },
					{ type: "tool", tool: "plan_read", state: { output: "plan" } },
				],
			},
		]);

		const output = await backgroundOutputTool.execute(
			{
				task_id: taskID,
				block: true,
				timeout: 1000,
				full_session: false,
			},
			{ sessionID: "parent-session" },
		);

		expect(output).toContain("Status: blocked");
		expect(output).toContain("Agent: frontend");
		expect(output).toContain("Activity: read=2, search=2, planning=2, edit=0");
		expect(output).toContain("Files changed: no");
		expect(output).toContain("Tiny frontend implementation task exceeded");
		expect(output).toContain("Root: ");
	});

	test("surfaces root, edit, and file-change telemetry for running frontend worktrees", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "op1-delegation-frontend-telemetry-"),
		);
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root);

		const client = createMockClient() as ReturnType<typeof createMockClient> & {
			setMessages: (sessionID: string, messages: unknown[]) => void;
		};
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Small /team page fix",
				prompt:
					"Update the /team page button spacing in packages/app/src/team/page.tsx.",
				subagent_type: "frontend",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		if (!worktreePath) {
			throw new Error("Expected worktree path");
		}

		await Bun.write(join(worktreePath, "feature.txt"), "frontend change\n");
		client.setMessages("child-session-1", [
			{
				id: "msg-1",
				info: {
					role: "assistant",
					time: { created: "2026-03-06T00:00:00.000Z" },
				},
				parts: [
					{ type: "tool", tool: "read", state: { output: "read" } },
					{ type: "tool", tool: "edit", state: { output: "edit" } },
				],
			},
		]);

		const output = await backgroundOutputTool.execute(
			{
				task_id: taskID,
				block: true,
				timeout: 1000,
				full_session: false,
			},
			{ sessionID: "parent-session" },
		);

		expect(output).toContain("Status: running");
		expect(output).toContain("Agent: frontend");
		expect(output).toContain("Activity: read=1, search=0, planning=0, edit=1");
		expect(output).toContain("Files changed: yes");
		expect(output).toContain(`Root: ${worktreePath}`);
	});

	test("verifies and merges worktree task changes on session idle", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-merge-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "merge-test",
				private: true,
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		});

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		expect(worktreePath).toBeDefined();
		if (!worktreePath) {
			throw new Error("Expected worktree path");
		}

		await Bun.write(join(worktreePath, "feature.txt"), "new feature\n");
		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		expect(await runCommand(["git", "show", "HEAD:feature.txt"], root)).toBe(
			"new feature",
		);
		const output = await backgroundOutputTool.execute(
			{ task_id: taskID, full_session: false },
			{ sessionID: "parent-session" },
		);
		expect(output).toContain("Task completed.");
		expect(output).toContain("Verified with `npm test` and merged branch");
	});

	test("fails worktree integration when verification fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-verify-fail-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "merge-test",
				private: true,
				scripts: { test: 'node -e "process.exit(1)"' },
			}),
		});

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		if (!worktreePath) {
			throw new Error("Expected worktree path");
		}

		await Bun.write(join(worktreePath, "feature.txt"), "new feature\n");
		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		expect(await Bun.file(join(root, "feature.txt")).exists()).toBe(false);
		const output = await backgroundOutputTool.execute(
			{ task_id: taskID, full_session: false },
			{ sessionID: "parent-session" },
		);
		expect(output).toContain("Status: failed");
		expect(output).toContain("Verification failed");
	});

	test("routes merge conflicts back to blocked task state for retry", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-conflict-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "merge-test",
				private: true,
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		});
		await Bun.write(join(root, "conflict.txt"), "base\n");
		await runCommand(["git", "add", "conflict.txt"], root);
		await runCommand(
			[
				"git",
				"-c",
				"user.name=Op1 Test",
				"-c",
				"user.email=op1@example.com",
				"commit",
				"-m",
				"add conflict file",
			],
			root,
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
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Update the conflict file.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		if (!worktreePath) {
			throw new Error("Expected worktree path");
		}

		await Bun.write(join(worktreePath, "conflict.txt"), "worker change\n");
		await Bun.write(join(root, "conflict.txt"), "root change\n");
		await runCommand(["git", "add", "conflict.txt"], root);
		await runCommand(
			[
				"git",
				"-c",
				"user.name=Op1 Test",
				"-c",
				"user.email=op1@example.com",
				"commit",
				"-m",
				"root conflict change",
			],
			root,
		);

		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		const output = await backgroundOutputTool.execute(
			{ task_id: taskID, full_session: false },
			{ sessionID: "parent-session" },
		);
		expect(output).toContain("Status: blocked");
		expect(output).toContain("Merge conflict");
	});

	test("records targeted verification and review gating for manager-owned CAID tasks", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-caid-targeted-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "caid-targeted",
				private: true,
			}),
		});
		await mkdir(join(root, "packages", "delegation", "src"), {
			recursive: true,
		});
		await Bun.write(
			join(root, "packages", "delegation", "feature.test.ts"),
			'import { expect, test } from "bun:test";\n\ntest("targeted verification", () => {\n\texpect(true).toBe(true);\n});\n',
		);
		await runCommand(["git", "add", "."], root);
		await runCommand(
			[
				"git",
				"-c",
				"user.name=Op1 Test",
				"-c",
				"user.email=op1@example.com",
				"commit",
				"-m",
				"add package tests",
			],
			root,
		);

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};
		const state = createTaskStateManager(join(root, ".opencode", "workspace"));
		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		if (!taskID || !worktreePath) {
			throw new Error("Expected task id and worktree path");
		}

		await state.updateTask(taskID, {
			assignment: {
				owner: "manager",
				workflow: "caid",
			},
		});
		await Bun.write(
			join(worktreePath, "packages", "delegation", "feature.test.ts"),
			'import { expect, test } from "bun:test";\n\ntest("targeted verification", () => {\n\texpect(true).toBe(true);\n});\n// updated in worker\n',
		);

		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		const updated = await state.getTask(taskID);
		expect(updated?.status).toBe("blocked");
		expect(updated?.execution?.verification_strategy).toBe("targeted");
		expect(updated?.assignment?.verification?.selected_command).toContain(
			"./packages/delegation",
		);
		expect(updated?.assignment?.review?.status).toBe("pending");

		const output = await backgroundOutputTool.execute(
			{ task_id: taskID, full_session: false },
			{ sessionID: "parent-session" },
		);
		expect(output).toContain("Status: blocked");
		expect(output).toContain("Verification: targeted");
		expect(output).toContain("Review: pending");
	});

	test("distinguishes dirty-root blocking for manager-owned CAID retries", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "op1-delegation-caid-dirty-root-"),
		);
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "dirty-root-test",
				private: true,
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		});

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};
		const state = createTaskStateManager(join(root, ".opencode", "workspace"));
		const taskTool = plugin.tool?.task as { execute: ToolExecute };

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		if (!taskID || !worktreePath) {
			throw new Error("Expected task id and worktree path");
		}

		await state.updateTask(taskID, {
			assignment: {
				owner: "manager",
				workflow: "caid",
			},
		});
		await Bun.write(join(worktreePath, "feature.txt"), "worker change\n");
		await Bun.write(join(root, "dirty.txt"), "root dirty\n");

		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		const updated = await state.getTask(taskID);
		expect(updated?.status).toBe("blocked");
		expect(updated?.execution?.merge_status).toBe("dirty_root");
		expect(updated?.assignment?.retry?.reason).toBe("dirty_root");
		expect(updated?.assignment?.retry?.state).toBe("blocked");
	});

	test("requires a reviewer continuation to complete manager-owned CAID review", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-caid-review-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "review-test",
				private: true,
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		});

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};
		const state = createTaskStateManager(join(root, ".opencode", "workspace"));
		const taskTool = plugin.tool?.task as { execute: ToolExecute };

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		if (!taskID || !worktreePath) {
			throw new Error("Expected task id and worktree path");
		}

		await state.updateTask(taskID, {
			assignment: {
				owner: "manager",
				workflow: "caid",
			},
		});
		await Bun.write(join(worktreePath, "feature.txt"), "new feature\n");

		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		const blocked = await state.getTask(taskID);
		expect(blocked?.status).toBe("blocked");
		expect(blocked?.assignment?.review?.status).toBe("pending");

		const completed = await taskTool.execute(
			{
				description: "Review integrated changes",
				prompt: "Perform the formal final manager review.",
				subagent_type: "reviewer",
				continue_task_id: taskID,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(completed).toContain("Task completed.");
		expect(completed).toContain("Manager review completed.");

		const reviewed = await state.getTask(taskID);
		expect(reviewed?.status).toBe("succeeded");
		expect(reviewed?.assignment?.review?.status).toBe("complete");
	});

	test("records resync failure durably before retrying manager-owned merge conflicts", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-caid-resync-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "resync-test",
				private: true,
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		});
		await Bun.write(join(root, "conflict.txt"), "base\n");
		await runCommand(["git", "add", "conflict.txt"], root);
		await runCommand(
			[
				"git",
				"-c",
				"user.name=Op1 Test",
				"-c",
				"user.email=op1@example.com",
				"commit",
				"-m",
				"add conflict file",
			],
			root,
		);

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};
		const state = createTaskStateManager(join(root, ".opencode", "workspace"));
		const taskTool = plugin.tool?.task as { execute: ToolExecute };

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Update the conflict file.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		expect(taskID).toBeDefined();
		if (!taskID || !worktreePath) {
			throw new Error("Expected task id and worktree path");
		}

		await state.updateTask(taskID, {
			assignment: {
				owner: "manager",
				workflow: "caid",
			},
		});
		await Bun.write(join(worktreePath, "conflict.txt"), "worker change\n");
		await Bun.write(join(root, "conflict.txt"), "root change\n");
		await runCommand(["git", "add", "conflict.txt"], root);
		await runCommand(
			[
				"git",
				"-c",
				"user.name=Op1 Test",
				"-c",
				"user.email=op1@example.com",
				"commit",
				"-m",
				"root conflict change",
			],
			root,
		);

		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		const blocked = await state.getTask(taskID);
		expect(blocked?.assignment?.retry?.reason).toBe("merge_conflict");
		expect(blocked?.assignment?.retry?.state).toBe("resync_required");
		const originalWorktree = blocked?.execution?.worktree_path;

		const retry = await taskTool.execute(
			{
				description: "Retry conflict task",
				prompt: "Retry the task after resync.",
				subagent_type: "coder",
				continue_task_id: taskID,
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		expect(retry).toContain("❌");
		const afterRetry = await state.getTask(taskID);
		expect(afterRetry?.assignment?.retry?.last_resync_status).toBe("failed");
		expect(afterRetry?.assignment?.retry?.state).toBe("blocked");
		expect(afterRetry?.execution?.worktree_path).toBe(originalWorktree);
	});

	test("accepts current runtime create and status response shapes", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "op1-delegation-runtime-shapes-"),
		);
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const client = createMockClient({
			createResponseShape: "nested-session",
			statusResponseShape: "direct-status",
			sessionParentKey: "parentId",
		});
		const plugin = await DelegationPlugin({
			directory: root,
			client,
		} as never);

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Explore code",
				prompt: "Inspect the repository.",
				subagent_type: "explore",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		expect(taskID).toBeDefined();

		client.setStatus("idle");
		const output = await backgroundOutputTool.execute(
			{
				task_id: taskID,
				block: true,
				timeout: 1000,
				full_session: false,
			},
			{ sessionID: "parent-session" },
		);

		expect(output).toContain("Task completed.");
		expect(output).toContain("background result");
	});

	test("auto-resumes the root session once after background child completion", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "op1-delegation-root-follow-through-"),
		);
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "follow-through-test",
				private: true,
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		});

		const client = createMockClient();
		const plugin = (await DelegationPlugin({
			directory: root,
			client,
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			event?: (input: { event: unknown }) => Promise<void>;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		if (!taskID || !worktreePath) {
			throw new Error("Expected worktree path");
		}

		await Bun.write(join(worktreePath, "feature.txt"), "new feature\n");
		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		expect(client.getPromptedSessionIDs()).toContain("parent-session");
		expect(
			client.getPromptedSessionIDs().filter((id) => id === "parent-session"),
		).toHaveLength(1);

		const status = await backgroundOutputTool.execute(
			{ task_id: taskID, full_session: false },
			{ sessionID: "parent-session" },
		);
		expect(status).toContain("Root follow-through: delivered");
		expect(status).toContain("Diff:");
		expect(status).toContain("Verification summary:");
	});

	test("keeps root follow-through pending when continuation is stopped", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-root-stopped-"));
		tempRoots.push(root);
		const workspaceDir = join(root, ".opencode", "workspace");
		await mkdir(workspaceDir, { recursive: true });
		await initializeGitRepo(root, {
			packageJson: JSON.stringify({
				name: "follow-through-stopped-test",
				private: true,
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		});
		await Bun.write(
			join(workspaceDir, "continuation.json"),
			JSON.stringify(
				{
					version: 1,
					sessions: {
						"parent-session": {
							session_id: "parent-session",
							mode: "stopped",
							updated_at: "2026-04-06T00:00:00.000Z",
							reason: "manual stop",
						},
					},
				},
				null,
				2,
			),
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
		const backgroundOutputTool = plugin.tool?.background_output as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Implement helper",
				prompt: "Add the helper and tests.",
				subagent_type: "coder",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		const worktreePath = client.getCreatedSessionDirectories()[0];
		if (!taskID || !worktreePath) {
			throw new Error("Expected task id and worktree path");
		}

		await Bun.write(join(worktreePath, "feature.txt"), "new feature\n");
		client.setStatus("idle");
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session-1" },
			},
		});

		expect(client.getPromptedSessionIDs()).not.toContain("parent-session");
		const pending = await createTaskStateManager(workspaceDir).getTask(taskID);
		expect(pending?.execution?.root_follow_through?.status).toBe("pending");

		const status = await backgroundOutputTool.execute(
			{ task_id: taskID, full_session: false },
			{ sessionID: "parent-session" },
		);
		expect(status).toContain("Root follow-through: delivered");
		expect(status).toContain("Verification summary:");
	});

	test("waives root follow-through when background work is explicitly cancelled", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-root-waived-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = (await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const cancelTool = plugin.tool?.background_cancel as {
			execute: ToolExecute;
		};

		const launch = await taskTool.execute(
			{
				description: "Explore code",
				prompt: "Inspect the repository",
				subagent_type: "explore",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		const taskID = launch.match(/Task ID: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
		if (!taskID) throw new Error("Expected task id");

		const cancelled = await cancelTool.execute(
			{ task_id: taskID, reason: "No longer needed" },
			{ sessionID: "parent-session" },
		);

		expect(cancelled).toContain("Root follow-through: waived");
		expect(cancelled).toContain("Cancelled: No longer needed");
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

		const plugin = (await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			"tool.execute.after"?: ToolExecuteAfter;
		};

		const taskTool = plugin.tool?.task as {
			execute: (args: unknown, toolCtx: unknown) => Promise<string>;
		};
		const cancelTool = plugin.tool?.background_cancel as {
			execute: (args: unknown, toolCtx: unknown) => Promise<string>;
		};
		const afterHook = plugin["tool.execute.after"] as ToolExecuteAfter;

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
			{ sessionID: "parent-session", callID: "cancel-call" },
		);
		const cancelOutput: {
			title: string;
			output: string;
			metadata: {
				truncated: boolean;
				task?: {
					task_id: string;
					status: string;
				};
			};
		} = {
			title: "",
			output: cancelled,
			metadata: { truncated: false },
		};
		await afterHook(
			{
				tool: "background_cancel",
				sessionID: "parent-session",
				callID: "cancel-call",
			},
			cancelOutput,
		);

		expect(taskID).toBeDefined();
		expect(cancelled).toContain("Status: cancelled");
		expect(cancelled).toContain("Cancelled: No longer needed");
		expect(cancelOutput.metadata.task?.task_id).toBe(taskID);
		expect(cancelOutput.metadata.task?.status).toBe("cancelled");
	});

	test("emits collection metadata when cancelling all background tasks", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-delegation-cancel-all-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode", "workspace"), { recursive: true });

		const plugin = (await DelegationPlugin({
			directory: root,
			client: createMockClient(),
		} as never)) as unknown as {
			tool?: Record<string, { execute: ToolExecute }>;
			"tool.execute.after"?: ToolExecuteAfter;
		};

		const taskTool = plugin.tool?.task as { execute: ToolExecute };
		const cancelTool = plugin.tool?.background_cancel as {
			execute: ToolExecute;
		};
		const afterHook = plugin["tool.execute.after"] as ToolExecuteAfter;

		await taskTool.execute(
			{
				description: "Explore code",
				prompt: "Inspect the repository",
				subagent_type: "explore",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);
		await taskTool.execute(
			{
				description: "Review docs",
				prompt: "Inspect the docs",
				subagent_type: "explore",
				run_in_background: true,
			},
			{ sessionID: "parent-session", ask: async () => {} },
		);

		const cancelled = await cancelTool.execute(
			{ all: true, reason: "Clean slate" },
			{ sessionID: "parent-session", callID: "cancel-all-call" },
		);
		const cancelOutput: {
			title: string;
			output: string;
			metadata: {
				truncated: boolean;
				count?: number;
				taskId?: string;
				task?: { task_id: string };
				taskIds?: string[];
				tasks?: Array<{ task_id: string; status: string }>;
			};
		} = {
			title: "",
			output: cancelled,
			metadata: { truncated: false },
		};
		await afterHook(
			{
				tool: "background_cancel",
				sessionID: "parent-session",
				callID: "cancel-all-call",
			},
			cancelOutput,
		);

		expect(cancelled).toContain("Cancelled 2 background task(s):");
		expect(cancelOutput.title).toBe("Cancelled background tasks");
		expect(cancelOutput.metadata.count).toBe(2);
		expect(cancelOutput.metadata.taskId).toBeUndefined();
		expect(cancelOutput.metadata.task).toBeUndefined();
		expect(cancelOutput.metadata.taskIds).toHaveLength(2);
		expect(cancelOutput.metadata.tasks).toHaveLength(2);
		expect(
			cancelOutput.metadata.tasks?.every((task) => task.status === "cancelled"),
		).toBe(true);
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
});
