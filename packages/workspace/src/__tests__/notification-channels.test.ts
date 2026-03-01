import { afterEach, describe, expect, test } from "bun:test";

import {
	createNotificationChannelsHook,
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
