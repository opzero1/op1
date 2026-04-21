import { afterEach, describe, expect, test } from "bun:test";

import {
	createInputNeededNotificationHook,
	createNotificationChannelsHook,
	createSessionReadyNotificationHook,
	type DesktopNotifier,
	type NotificationClient,
	resetNotificationChannelsState,
} from "../hooks/notification-channels";

const originalNotifications = Bun.env.OP7_WORKSPACE_NOTIFICATIONS;
const originalQuietHours = Bun.env.OP7_WORKSPACE_NOTIFICATIONS_QUIET_HOURS;
const originalTimezone = Bun.env.OP7_WORKSPACE_NOTIFICATIONS_TIMEZONE;
const originalPrivacy = Bun.env.OP7_WORKSPACE_NOTIFICATIONS_PRIVACY;

afterEach(() => {
	resetNotificationChannelsState();
	if (originalNotifications === undefined) {
		delete Bun.env.OP7_WORKSPACE_NOTIFICATIONS;
	} else {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = originalNotifications;
	}

	if (originalQuietHours === undefined) {
		delete Bun.env.OP7_WORKSPACE_NOTIFICATIONS_QUIET_HOURS;
	} else {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_QUIET_HOURS = originalQuietHours;
	}

	if (originalTimezone === undefined) {
		delete Bun.env.OP7_WORKSPACE_NOTIFICATIONS_TIMEZONE;
	} else {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_TIMEZONE = originalTimezone;
	}

	if (originalPrivacy === undefined) {
		delete Bun.env.OP7_WORKSPACE_NOTIFICATIONS_PRIVACY;
	} else {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_PRIVACY = originalPrivacy;
	}
});

describe("notification channels hook", () => {
	test("is disabled by default", async () => {
		const calls: Array<{
			level: string;
			message: string;
			extra?: Record<string, unknown>;
		}> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({
						level: body.level,
						message: body.message,
						extra: body.extra,
					});
				},
			},
		};

		const hook = createNotificationChannelsHook(client, { desktop: false });
		await hook(
			{ tool: "task", sessionID: "s1", callID: "c1" },
			{ title: "Task", output: "ok", metadata: {} },
		);

		expect(calls.length).toBe(0);
	});

	test("emits deduplicated task notifications when enabled", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const calls: Array<{
			level: string;
			message: string;
			extra?: Record<string, unknown>;
		}> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({
						level: body.level,
						message: body.message,
						extra: body.extra,
					});
				},
			},
		};

		const hook = createNotificationChannelsHook(client, { desktop: false });

		await hook(
			{ tool: "task", sessionID: "s2", callID: "c2" },
			{ title: "Task Run", output: "ok", metadata: {} },
		);

		await hook(
			{ tool: "task", sessionID: "s2", callID: "c2" },
			{ title: "Task Run", output: "ok", metadata: {} },
		);

		expect(calls.length).toBe(1);
		expect(calls[0].level).toBe("info");
		expect(calls[0].message).toContain("Task tool completed");
	});

	test("maps doctor status to notification severity", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "on";

		const calls: Array<{
			level: string;
			message: string;
			extra?: Record<string, unknown>;
		}> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({
						level: body.level,
						message: body.message,
						extra: body.extra,
					});
				},
			},
		};

		const hook = createNotificationChannelsHook(client, { desktop: false });

		await hook(
			{ tool: "doctor", sessionID: "s3", callID: "c3" },
			{ title: "Doctor", output: "status: warn", metadata: {} },
		);

		await hook(
			{ tool: "doctor", sessionID: "s3", callID: "c4" },
			{ title: "Doctor", output: "status: error", metadata: {} },
		);

		expect(calls.length).toBe(2);
		expect(calls[0].level).toBe("warn");
		expect(calls[1].level).toBe("error");
	});

	test("suppresses notifications during quiet hours", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_QUIET_HOURS = "09:00-17:00";
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_TIMEZONE = "UTC";

		const calls: Array<{ level: string; message: string }> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({ level: body.level, message: body.message });
				},
			},
		};

		const hook = createNotificationChannelsHook(client, {
			desktop: false,
			now: () => new Date("2026-03-01T12:00:00.000Z"),
		});

		await hook(
			{ tool: "task", sessionID: "s4", callID: "c1" },
			{ title: "Quiet Window", output: "ok", metadata: {} },
		);

		expect(calls.length).toBe(0);
	});

	test("strict privacy omits tool metadata by default", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const calls: Array<{ extra?: Record<string, unknown> }> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({ extra: body.extra });
				},
			},
		};

		const hook = createNotificationChannelsHook(client, { desktop: false });
		await hook(
			{ tool: "task", sessionID: "s5", callID: "c1" },
			{ title: "Privacy", output: "ok", metadata: {} },
		);

		expect(calls.length).toBe(1);
		expect(calls[0].extra?.privacy_mode).toBe("strict");
		expect(calls[0].extra?.tool).toBeUndefined();
	});

	test("strict privacy redacts delegated routing breadcrumbs from log messages", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const calls: Array<{ message: string; extra?: Record<string, unknown> }> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({ message: body.message, extra: body.extra });
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "root-session",
			source: "delegation.task-1.permission.updated",
			kind: "permission",
			routingContext: {
				rootSessionID: "root-session",
				childSessionID: "child-session",
				taskID: "task-1",
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].message).toBe("Assistant needs permission to continue.");
		expect(calls[0].message).not.toContain("root-session");
		expect(calls[0].message).not.toContain("child-session");
		expect(calls[0].message).not.toContain("task-1");
		expect(calls[0].extra?.root_session_id).toBeUndefined();
		expect(calls[0].extra?.child_session_id).toBeUndefined();
		expect(calls[0].extra?.task_id).toBeUndefined();
	});

	test("balanced privacy includes tool metadata", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_PRIVACY = "balanced";

		const calls: Array<{ extra?: Record<string, unknown> }> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({ extra: body.extra });
				},
			},
		};

		const hook = createNotificationChannelsHook(client, { desktop: false });
		await hook(
			{ tool: "doctor", sessionID: "s6", callID: "c1" },
			{ title: "Doctor", output: "status: warn", metadata: {} },
		);

		expect(calls.length).toBe(1);
		expect(calls[0].extra?.privacy_mode).toBe("balanced");
		expect(calls[0].extra?.tool).toBe("doctor");
	});

	test("emits TUI toast notifications when available", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const toasts: Array<{
			title?: string;
			message?: string;
			variant?: string;
		}> = [];
		const client: NotificationClient = {
			tui: {
				showToast: async ({ body }) => {
					toasts.push({
						title: body?.title,
						message: body?.message,
						variant: body?.variant,
					});
				},
			},
		};

		const hook = createNotificationChannelsHook(client, { desktop: false });
		await hook(
			{ tool: "doctor", sessionID: "s8", callID: "c1" },
			{ title: "Doctor", output: "status: warn", metadata: {} },
		);

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Doctor Status");
		expect(toasts[0].message).toContain("WARN status");
		expect(toasts[0].variant).toBe("warning");
	});

	test("emits desktop notifications when enabled", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const desktopCalls: Array<{ title: string; message: string }> = [];
		const desktopNotifier: DesktopNotifier = {
			notify: (options, callback) => {
				desktopCalls.push({ title: options.title, message: options.message });
				callback?.(null);
			},
		};

		const hook = createNotificationChannelsHook(
			{},
			{ desktop: true, desktopNotifier },
		);
		await hook(
			{ tool: "task", sessionID: "s9", callID: "c1" },
			{ title: "Desktop Task", output: "ok", metadata: {} },
		);

		expect(desktopCalls.length).toBe(1);
		expect(desktopCalls[0].title).toBe("Task Complete");
		expect(desktopCalls[0].message).toContain("Desktop Task");
	});

	test("emits session ready notifications when enabled", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const toasts: Array<{
			title?: string;
			message?: string;
			variant?: string;
		}> = [];
		const client: NotificationClient = {
			tui: {
				showToast: async ({ body }) => {
					toasts.push({
						title: body?.title,
						message: body?.message,
						variant: body?.variant,
					});
				},
			},
		};

		const hook = createSessionReadyNotificationHook(client, { desktop: false });
		await hook({ sessionID: "session-1" });

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Ready for Input");
		expect(toasts[0].message).toContain("Ready for your next prompt");
		expect(toasts[0].variant).toBe("success");
	});

	test("emits question notifications when enabled", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const toasts: Array<{
			title?: string;
			message?: string;
			variant?: string;
		}> = [];
		const client: NotificationClient = {
			tui: {
				showToast: async ({ body }) => {
					toasts.push({
						title: body?.title,
						message: body?.message,
						variant: body?.variant,
					});
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "session-question",
			callID: "call-question",
			tool: "question",
			source: "tool.execute.before",
			questionText: "Which branch should we use?",
		});

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Question for You");
		expect(toasts[0].message).toContain("asking a question");
		expect(toasts[0].variant).toBe("success");
	});

	test("uses plan-specific wording for plan input-needed notifications", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const toasts: Array<{ title?: string; message?: string }> = [];
		const client: NotificationClient = {
			tui: {
				showToast: async ({ body }) => {
					toasts.push({ title: body?.title, message: body?.message });
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "session-plan",
			source: "message.updated",
			kind: "plan",
			questionText:
				"Please review /plan and confirm the implementation phase choices.",
		});

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Plan Input Needed");
		expect(toasts[0].message).toContain("Plan workflow needs your decision");
	});

	test("keeps explicit plan kind even when question text contains permission keywords", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const toasts: Array<{ title?: string; message?: string }> = [];
		const client: NotificationClient = {
			tui: {
				showToast: async ({ body }) => {
					toasts.push({ title: body?.title, message: body?.message });
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "session-plan-overrides-keyword",
			kind: "plan",
			questionText: "Please grant permission and confirm /plan phases.",
		});

		expect(toasts).toHaveLength(1);
		expect(toasts[0].title).toBe("Plan Input Needed");
		expect(toasts[0].message).toContain("Plan workflow needs your decision");
		expect(toasts[0].message).not.toContain("needs permission");
	});

	test("does not dedupe distinct plain-text input-needed questions in the same session", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const toasts: Array<{ title?: string; message?: string }> = [];
		const client: NotificationClient = {
			tui: {
				showToast: async ({ body }) => {
					toasts.push({ title: body?.title, message: body?.message });
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "session-question",
			kind: "question",
			questionText: "Which scope should we use?",
		});
		await hook({
			sessionID: "session-question",
			kind: "question",
			questionText: "Which verification depth should we use?",
		});

		expect(toasts).toHaveLength(2);
		expect(toasts[0]?.message).toContain("asking a question");
		expect(toasts[1]?.message).toContain("asking a question");
	});

	test("maps permission-like questions to permission notifications", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const toasts: Array<{ title?: string; message?: string }> = [];
		const client: NotificationClient = {
			tui: {
				showToast: async ({ body }) => {
					toasts.push({ title: body?.title, message: body?.message });
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "session-permission-question",
			callID: "call-permission-question",
			tool: "question",
			source: "tool.execute.before",
			questionText: "Need permission to continue with this action?",
		});

		expect(toasts.length).toBe(1);
		expect(toasts[0].title).toBe("Permission Needed");
		expect(toasts[0].message).toContain("needs permission");
	});

	test("adds delegated routing breadcrumbs in balanced privacy mode", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_PRIVACY = "balanced";

		const calls: Array<{ extra?: Record<string, unknown>; message: string }> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({ extra: body.extra, message: body.message });
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "root-session",
			source: "delegation.task-1.permission.updated",
			kind: "permission",
			routingContext: {
				rootSessionID: "root-session",
				childSessionID: "child-session",
				taskID: "task-1",
			},
		});

		expect(calls.length).toBe(1);
		expect(calls[0].extra?.root_session_id).toBe("root-session");
		expect(calls[0].extra?.child_session_id).toBe("child-session");
		expect(calls[0].extra?.task_id).toBe("task-1");
		expect(calls[0].message).toContain("task task-1");
	});

	test("uses clearer desktop copy for delegated plan input notifications", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const desktopCalls: Array<{ title: string; message: string }> = [];
		const desktopNotifier: DesktopNotifier = {
			notify: (options, callback) => {
				desktopCalls.push({ title: options.title, message: options.message });
				callback?.(null);
			},
		};

		const hook = createInputNeededNotificationHook(
			{},
			{ desktop: true, desktopNotifier },
		);
		await hook({
			sessionID: "root-session",
			kind: "plan",
			routingContext: {
				rootSessionID: "root-session",
				childSessionID: "child-session",
				taskID: "task-1",
			},
		});

		expect(desktopCalls).toHaveLength(1);
		expect(desktopCalls[0].title).toBe("Plan Input Needed (Delegated)");
		expect(desktopCalls[0].message).toContain(
			"Plan workflow is blocked and needs your decision.",
		);
		expect(desktopCalls[0].message).toContain("child child-session");
		expect(desktopCalls[0].message).toContain("task task-1");
		expect(desktopCalls[0].message).toContain("root root-session");
	});

	test("emits permission notifications when enabled", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const calls: Array<{ message: string }> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({ message: body.message });
				},
			},
		};

		const hook = createInputNeededNotificationHook(client, { desktop: false });
		await hook({
			sessionID: "session-permission",
			source: "permission.updated",
			kind: "permission",
		});

		expect(calls.length).toBe(1);
		expect(calls[0].message).toContain("needs permission");
	});

	test("deduplicates session ready notifications per session and source", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const calls: Array<{ message: string }> = [];
		const client: NotificationClient = {
			app: {
				log: async ({ body }) => {
					calls.push({ message: body.message });
				},
			},
		};

		const hook = createSessionReadyNotificationHook(client, { desktop: false });
		await hook({ sessionID: "session-2", source: "session.idle" });
		await hook({ sessionID: "session-2", source: "session.idle" });
		await hook({ sessionID: "session-2", source: "session.idle.secondary" });

		expect(calls.length).toBe(2);
		expect(calls[0].message).toContain("Assistant turn complete");
	});

	test("gracefully no-ops when notification channels are unavailable", async () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";

		const hook = createNotificationChannelsHook({}, { desktop: false });

		await expect(
			hook(
				{ tool: "task", sessionID: "s7", callID: "c1" },
				{ title: "No Logger", output: "ok", metadata: {} },
			),
		).resolves.toBeUndefined();
	});
});
