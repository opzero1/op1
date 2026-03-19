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

function createMockClient(toasts: Array<{ title?: string; message?: string }>) {
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
			promptAsync: async () => ({}),
			messages: async () => ({ data: [] }),
			abort: async () => ({}),
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

	test("suppresses ready notifications for delegated child sessions", async () => {
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
							child_session_id: "child-session",
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

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Ready for Input");
	});
});
