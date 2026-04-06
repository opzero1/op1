import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat.js";
import { resetNotificationChannelsState } from "../hooks/notification-channels.js";
import { WorkspacePlugin } from "../index.js";

const tempRoots: string[] = [];

afterEach(async () => {
	resetNotificationChannelsState();
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

function createMockClient(
	toasts: Array<{ title?: string; message?: string }>,
	options?: { sessionMessages?: Record<string, unknown[]> },
) {
	const promptAsyncRequests: Array<{ sessionID: string; text?: string }> = [];
	const sessionMessages = { ...(options?.sessionMessages ?? {}) };
	return {
		app: {
			log: async () => {},
		},
		tui: {
			showToast: async ({
				body,
			}: {
				body?: { title?: string; message?: string };
			}) => {
				toasts.push({
					title: body?.title,
					message: body?.message,
				});
			},
		},
		session: {
			get: async () => ({ data: { id: "session" } }),
			create: async () => ({ data: { id: "child" } }),
			promptAsync: async (input: {
				path: { id: string };
				body?: { parts?: Array<{ type?: string; text?: string }> };
			}) => {
				promptAsyncRequests.push({
					sessionID: input.path.id,
					text:
						input.body?.parts?.[0]?.type === "text"
							? input.body.parts[0]?.text
							: undefined,
				});
				return {};
			},
			messages: async (input: { path: { id: string } }) => ({
				data: sessionMessages[input.path.id] ?? [],
			}),
			abort: async () => ({}),
		},
		getPromptAsyncRequests() {
			return [...promptAsyncRequests];
		},
	};
}

describe("workspace notification event hook", () => {
	test("emits a ready notification for foreground session idle", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-notification-event-"));
		tempRoots.push(root);
		const toasts: Array<{ title?: string; message?: string }> = [];

		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient(toasts),
		} as never);

		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "foreground-session" },
			},
		});

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Ready for Input");
	});

	test("reroutes delegated child idle notifications to the root session", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-notification-child-"));
		tempRoots.push(root);
		const workspaceDir = join(root, ".opencode", "workspace");
		await mkdir(workspaceDir, { recursive: true });
		await Bun.write(
			join(workspaceDir, "task-records.json"),
			JSON.stringify(
				{
					version: 3,
					delegations: {
						"task-1": {
							id: "task-1",
							root_session_id: "root-session",
							child_session_id: "child-session",
							status: "succeeded",
							run_in_background: true,
						},
					},
				},
				null,
				2,
			),
		);

		const toasts: Array<{ title?: string; message?: string }> = [];
		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient(toasts),
		} as never);

		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "child-session" },
			},
		});
		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "foreground-session" },
			},
		});

		expect(toasts.length).toBe(2);
		expect(toasts[0].title).toBe("Ready for Input");
		expect(toasts[1].title).toBe("Ready for Input");
	});

	test("emits a permission notification toast for permission events", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-notification-permission-"));
		tempRoots.push(root);
		const toasts: Array<{ title?: string; message?: string }> = [];

		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient(toasts),
		} as never);
		const pluginRecord = plugin as {
			event?: (input: { event: unknown }) => Promise<void>;
		};

		await pluginRecord.event?.({
			event: {
				type: "permission.updated",
				properties: { sessionID: "foreground-session" },
			},
		});

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Permission Needed");
	});

	test("prompts the root session again when idle completion would orphan active child work", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-notification-complete-"));
		tempRoots.push(root);
		const workspaceDir = join(root, ".opencode", "workspace");
		const toasts: Array<{ title?: string; message?: string }> = [];
		await mkdir(workspaceDir, { recursive: true });
		await Bun.write(
			join(workspaceDir, "task-records.json"),
			JSON.stringify(
				{
					version: 3,
					delegations: {
						"task-1": {
							id: "task-1",
							root_session_id: "root-session",
							child_session_id: "child-session",
							status: "running",
							run_in_background: true,
						},
					},
				},
				null,
				2,
			),
		);

		const client = createMockClient(toasts, {
			sessionMessages: {
				"root-session": [
					{
						id: "msg-1",
						info: {
							role: "assistant",
							time: { created: "2026-04-06T00:00:00.000Z" },
						},
						parts: [{ type: "text", text: "<done>COMPLETE</done>" }],
					},
				],
			},
		}) as ReturnType<typeof createMockClient> & {
			getPromptAsyncRequests: () => Array<{ sessionID: string; text?: string }>;
		};
		const plugin = await WorkspacePlugin({
			directory: root,
			client,
		} as never);

		await plugin.event?.({
			event: {
				type: "session.idle",
				properties: { sessionID: "root-session" },
			},
		});

		expect(client.getPromptAsyncRequests()).toHaveLength(1);
		expect(client.getPromptAsyncRequests()[0]?.sessionID).toBe("root-session");
		expect(client.getPromptAsyncRequests()[0]?.text).toContain(
			"ROOT JOIN GUARD",
		);
	});

	test("prompts the root session again on message update when completion would orphan active child work", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-notification-message-"));
		tempRoots.push(root);
		const workspaceDir = join(root, ".opencode", "workspace");
		const toasts: Array<{ title?: string; message?: string }> = [];
		await mkdir(workspaceDir, { recursive: true });
		await Bun.write(
			join(workspaceDir, "task-records.json"),
			JSON.stringify(
				{
					version: 3,
					delegations: {
						"task-1": {
							id: "task-1",
							root_session_id: "root-session",
							child_session_id: "child-session",
							status: "running",
							run_in_background: true,
						},
					},
				},
				null,
				2,
			),
		);

		const client = createMockClient(toasts, {
			sessionMessages: {
				"root-session": [
					{
						id: "msg-1",
						info: {
							role: "assistant",
							time: { created: "2026-04-06T00:00:00.000Z" },
						},
						parts: [{ type: "text", text: "<done>COMPLETE</done>" }],
					},
				],
			},
		}) as ReturnType<typeof createMockClient> & {
			getPromptAsyncRequests: () => Array<{ sessionID: string; text?: string }>;
		};
		const plugin = await WorkspacePlugin({
			directory: root,
			client,
		} as never);

		const pluginRecord = plugin as {
			event?: (input: { event: unknown }) => Promise<void>;
		};

		await pluginRecord.event?.({
			event: {
				type: "message.updated",
				properties: { sessionID: "root-session" },
			},
		});

		expect(client.getPromptAsyncRequests()).toHaveLength(1);
		expect(client.getPromptAsyncRequests()[0]?.sessionID).toBe("root-session");
		expect(client.getPromptAsyncRequests()[0]?.text).toContain(
			"ROOT JOIN GUARD",
		);
	});

	test("emits a question notification toast before question tool execution", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-notification-question-"));
		tempRoots.push(root);
		const toasts: Array<{ title?: string; message?: string }> = [];

		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient(toasts),
		} as never);
		const pluginRecord = plugin as {
			hook?: Record<string, unknown>;
		};

		const beforeHook = pluginRecord.hook?.["tool.execute.before"] as
			| ((
					input: { tool: string; sessionID: string; callID: string },
					output: { args: Record<string, unknown> },
			  ) => Promise<void>)
			| undefined;

		expect(beforeHook).toBeDefined();

		await beforeHook?.(
			{
				tool: "question",
				sessionID: "foreground-session",
				callID: "call-question",
			},
			{
				args: {
					questions: [
						{
							question: "Which option should we choose?",
							options: [{ label: "A" }, { label: "B" }],
						},
					],
				},
			},
		);

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Question for You");
	});
});
