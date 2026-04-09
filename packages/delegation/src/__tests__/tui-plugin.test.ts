import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { TuiPluginModule } from "../tui/types.js";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("tui module export", () => {
	test("default export matches TuiPluginModule shape", async () => {
		const mod = await import("../tui/index.js");
		const plugin = mod.default as TuiPluginModule;

		expect(plugin).toBeDefined();
		expect(plugin.id).toBe("@op1/delegation");
		expect(typeof plugin.tui).toBe("function");
		expect(plugin.server).toBeUndefined();
	});

	test("re-exports buildTaskGraph", async () => {
		const mod = await import("../tui/index.js");
		expect(typeof mod.buildTaskGraph).toBe("function");
	});

	test("re-exports format utilities", async () => {
		const mod = await import("../tui/index.js");
		expect(typeof mod.formatNodeTitle).toBe("function");
		expect(typeof mod.formatNodeDescription).toBe("function");
		expect(typeof mod.formatNodeCategory).toBe("function");
		expect(typeof mod.formatGraphSummaryLine).toBe("function");
		expect(typeof mod.formatGraphTree).toBe("function");
		expect(typeof mod.statusIcon).toBe("function");
		expect(typeof mod.statusLabel).toBe("function");
	});

	test("re-exports installDelegationPlugin", async () => {
		const mod = await import("../tui/index.js");
		expect(typeof mod.installDelegationPlugin).toBe("function");
	});
});

describe("installDelegationPlugin", () => {
	test("registers route and command", async () => {
		const { installDelegationPlugin } = await import("../tui/plugin.js");

		const registeredRoutes: unknown[] = [];
		const registeredCommands: unknown[] = [];
		const navigations: Array<{
			name: string;
			params?: Record<string, unknown>;
		}> = [];

		const mockApi = {
			route: {
				register: (routes: unknown[]) => {
					registeredRoutes.push(...routes);
					return () => {};
				},
				navigate: (name: string, params?: Record<string, unknown>) => {
					navigations.push({ name, params });
				},
				current: { name: "home", params: undefined },
			},
			command: {
				register: (cb: () => unknown[]) => {
					registeredCommands.push(...cb());
					return () => {};
				},
				trigger: () => {},
				show: () => {},
			},
			slots: {
				register: () => "slot-0",
			},
			ui: {
				DialogSelect: () => null,
				toast: () => {},
				dialog: { replace: () => {}, clear: () => {} },
			},
			state: {
				ready: true,
				path: {
					state: "/tmp/state",
					config: "/tmp/config",
					worktree: "/tmp/project",
					directory: "/tmp/project",
				},
			},
			lifecycle: {
				signal: new AbortController().signal,
				onDispose: () => () => {},
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await installDelegationPlugin(mockApi as any);

		// Route registered
		expect(registeredRoutes).toHaveLength(1);
		expect((registeredRoutes[0] as { name: string }).name).toBe("delegation");
		expect(typeof (registeredRoutes[0] as { render: unknown }).render).toBe(
			"function",
		);

		// Command registered
		expect(registeredCommands).toHaveLength(1);
		expect((registeredCommands[0] as { title: string }).title).toBe(
			"Delegation Tasks",
		);
		expect((registeredCommands[0] as { value: string }).value).toBe(
			"delegation.tasks",
		);
		(registeredCommands[0] as { onSelect: () => void }).onSelect();
		expect(navigations).toEqual([{ name: "delegation", params: undefined }]);
	});

	test("command preserves the active session when launched from a session route", async () => {
		const { installDelegationPlugin } = await import("../tui/plugin.js");

		const registeredCommands: unknown[] = [];
		const navigations: Array<{
			name: string;
			params?: Record<string, unknown>;
		}> = [];

		const mockApi = {
			route: {
				register: () => () => {},
				navigate: (name: string, params?: Record<string, unknown>) => {
					navigations.push({ name, params });
				},
				current: { name: "session", params: { sessionID: "ses-current" } },
			},
			command: {
				register: (cb: () => unknown[]) => {
					registeredCommands.push(...cb());
					return () => {};
				},
				trigger: () => {},
				show: () => {},
			},
			slots: { register: () => "slot-0" },
			ui: {
				DialogSelect: () => null,
				toast: () => {},
				dialog: { replace: () => {}, clear: () => {} },
			},
			state: {
				ready: true,
				path: {
					state: "/tmp/state",
					config: "/tmp/config",
					worktree: "/tmp/project",
					directory: "/tmp/project",
				},
			},
			lifecycle: {
				signal: new AbortController().signal,
				onDispose: () => () => {},
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await installDelegationPlugin(mockApi as any);
		(registeredCommands[0] as { onSelect: () => void }).onSelect();

		expect(navigations).toEqual([
			{ name: "delegation", params: { sessionID: "ses-current" } },
		]);
	});

	test("route render opens a dialog for a ready workspace", async () => {
		const { installDelegationPlugin } = await import("../tui/plugin.js");

		const registeredRoutes: Array<{ name: string; render: () => unknown }> = [];
		let dialogOpened = 0;

		const workspaceDir = await Bun.$`mktemp -d`.text();
		const directory = workspaceDir.trim();
		await mkdir(`${directory}/.opencode/workspace`, { recursive: true });
		await Bun.write(
			`${directory}/.opencode/workspace/task-records.json`,
			JSON.stringify(
				{
					version: 3,
					delegations: {
						"task-1": {
							id: "task-1",
							description: "Inspect runtime",
							status: "running",
							agent: "coder",
							root_session_id: "root-1",
							parent_session_id: "parent-1",
							child_session_id: "child-1",
							prompt: "Inspect runtime",
							run_in_background: true,
							created_at: "2026-04-09T00:00:00.000Z",
							updated_at: "2026-04-09T00:00:00.000Z",
						},
					},
				},
				null,
				2,
			),
		);

		const mockApi = {
			route: {
				register: (routes: Array<{ name: string; render: () => unknown }>) => {
					registeredRoutes.push(...routes);
					return () => {};
				},
				navigate: () => {},
				current: { name: "home", params: undefined },
			},
			command: { register: () => () => {}, trigger: () => {}, show: () => {} },
			slots: { register: () => "slot-0" },
			ui: {
				DialogSelect: () => null,
				toast: () => {},
				dialog: {
					replace: () => {
						dialogOpened += 1;
					},
					clear: () => {},
				},
			},
			state: {
				ready: true,
				path: {
					state: `${directory}/.opencode/state.json`,
					config: `${directory}/.opencode/config.json`,
					worktree: directory,
					directory,
				},
			},
			lifecycle: {
				signal: new AbortController().signal,
				onDispose: () => () => {},
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await installDelegationPlugin(mockApi as any);
		expect(registeredRoutes).toHaveLength(1);

		const firstRoute = registeredRoutes[0];
		expect(firstRoute).toBeDefined();
		firstRoute?.render();
		await flushMicrotasks();

		expect(dialogOpened).toBe(1);
	});

	test("route render navigates home when workspace directory is unavailable", async () => {
		const { installDelegationPlugin } = await import("../tui/plugin.js");

		const registeredRoutes: Array<{ name: string; render: () => unknown }> = [];
		const navigations: Array<{
			name: string;
			params?: Record<string, unknown>;
		}> = [];
		const toasts: Array<{ variant?: string; message: string }> = [];

		const mockApi = {
			route: {
				register: (routes: Array<{ name: string; render: () => unknown }>) => {
					registeredRoutes.push(...routes);
					return () => {};
				},
				navigate: (name: string, params?: Record<string, unknown>) => {
					navigations.push({ name, params });
				},
				current: { name: "delegation", params: undefined },
			},
			command: { register: () => () => {}, trigger: () => {}, show: () => {} },
			slots: { register: () => "slot-0" },
			ui: {
				DialogSelect: () => null,
				toast: (input: { variant?: string; message: string }) => {
					toasts.push(input);
				},
				dialog: { replace: () => {}, clear: () => {} },
			},
			state: {
				ready: true,
				path: {
					state: "/tmp/.opencode/state.json",
					config: "/tmp/.opencode/config.json",
					worktree: "/tmp/project",
					directory: "",
				},
			},
			lifecycle: {
				signal: new AbortController().signal,
				onDispose: () => () => {},
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await installDelegationPlugin(mockApi as any);
		const firstRoute = registeredRoutes[0];
		expect(firstRoute).toBeDefined();
		firstRoute?.render();
		await flushMicrotasks();

		expect(navigations).toContainEqual({ name: "home", params: undefined });
		expect(toasts).toContainEqual({
			variant: "warning",
			message: "Workspace directory not available yet.",
		});
	});

	test("route render returns to source session when no scoped tasks are found", async () => {
		const { installDelegationPlugin } = await import("../tui/plugin.js");

		const registeredRoutes: Array<{ name: string; render: () => unknown }> = [];
		const navigations: Array<{
			name: string;
			params?: Record<string, unknown>;
		}> = [];
		const toasts: Array<{ variant?: string; message: string }> = [];

		const workspaceDir = await Bun.$`mktemp -d`.text();
		const directory = workspaceDir.trim();
		await mkdir(`${directory}/.opencode/workspace`, { recursive: true });
		await Bun.write(
			`${directory}/.opencode/workspace/task-records.json`,
			JSON.stringify(
				{
					version: 3,
					delegations: {
						"task-1": {
							id: "task-1",
							description: "Other session task",
							status: "running",
							agent: "coder",
							root_session_id: "ses-other",
							parent_session_id: "ses-other",
							child_session_id: "ses-child-other",
							prompt: "Inspect runtime",
							run_in_background: true,
							created_at: "2026-04-09T00:00:00.000Z",
							updated_at: "2026-04-09T00:00:00.000Z",
						},
					},
				},
				null,
				2,
			),
		);

		const mockApi = {
			route: {
				register: (routes: Array<{ name: string; render: () => unknown }>) => {
					registeredRoutes.push(...routes);
					return () => {};
				},
				navigate: (name: string, params?: Record<string, unknown>) => {
					navigations.push({ name, params });
				},
				current: { name: "delegation", params: { sessionID: "ses-current" } },
			},
			command: { register: () => () => {}, trigger: () => {}, show: () => {} },
			slots: { register: () => "slot-0" },
			ui: {
				DialogSelect: () => null,
				toast: (input: { variant?: string; message: string }) => {
					toasts.push(input);
				},
				dialog: { replace: () => {}, clear: () => {} },
			},
			state: {
				ready: true,
				path: {
					state: `${directory}/.opencode/state.json`,
					config: `${directory}/.opencode/config.json`,
					worktree: directory,
					directory,
				},
			},
			lifecycle: {
				signal: new AbortController().signal,
				onDispose: () => () => {},
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await installDelegationPlugin(mockApi as any);
		const firstRoute = registeredRoutes[0];
		expect(firstRoute).toBeDefined();
		firstRoute?.render();
		await flushMicrotasks();

		expect(navigations).toContainEqual({
			name: "session",
			params: { sessionID: "ses-current" },
		});
		expect(toasts).toContainEqual({
			variant: "info",
			message: "No delegation tasks found.",
		});
	});
});
