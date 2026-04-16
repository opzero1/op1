import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFastModeDialogOptions,
	formatFastModeDialogTitle,
	getFastModeTuiTargets,
} from "../tui/options.js";
import type { TuiPluginModule } from "../tui/types.js";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	delete process.env.XDG_CONFIG_HOME;
});

describe("fast mode tui options", () => {
	test("returns configured provider/model targets", () => {
		expect(
			getFastModeTuiTargets({
				enabled: true,
				providers: {
					openai: {
						enabled: true,
						agents: ["build", "coder"],
						models: ["gpt-5.4", "gpt-5.3-codex"],
					},
					anthropic: {
						enabled: false,
						agents: ["build"],
						models: ["claude-sonnet"],
					},
				},
			}),
		).toEqual([
			{ providerID: "openai", modelID: "gpt-5.3-codex" },
			{ providerID: "openai", modelID: "gpt-5.4" },
		]);
	});

	test("renders OFF labels when no models are enabled", () => {
		const options = buildFastModeDialogOptions({
			config: {
				enabled: true,
				providers: {
					openai: {
						enabled: true,
						agents: ["build", "coder"],
						models: ["gpt-5.4", "gpt-5.3-codex"],
					},
				},
			},
			state: { providers: {} },
			onSelect: () => {},
		});

		expect(options.map((option) => option.title)).toEqual([
			"○ OFF gpt-5.3-codex",
			"○ OFF gpt-5.4",
		]);
		expect(options.map((option) => option.category)).toEqual([
			"openai",
			"openai",
		]);
	});

	test("renders ON label for enabled models", () => {
		const options = buildFastModeDialogOptions({
			config: {
				enabled: true,
				providers: {
					openai: {
						enabled: true,
						agents: ["build", "coder"],
						models: ["gpt-5.4", "gpt-5.3-codex"],
					},
				},
			},
			state: {
				providers: { openai: { models: { "gpt-5.4": true } } },
			},
			onSelect: () => {},
		});

		expect(options.map((option) => option.title)).toEqual([
			"○ OFF gpt-5.3-codex",
			"● ON  gpt-5.4",
		]);
	});

	test("formats config-aware title", () => {
		expect(
			formatFastModeDialogTitle(
				{ enabled: false, providers: {} },
				{ providers: { openai: { models: { "gpt-5.4": true } } } },
			),
		).toBe("Fast Mode — config disabled");

		expect(
			formatFastModeDialogTitle(
				{ enabled: true, providers: {} },
				{ providers: {} },
			),
		).toBe("Fast Mode — no configured models");

		expect(
			formatFastModeDialogTitle(
				{
					enabled: true,
					providers: {
						openai: {
							enabled: true,
							agents: ["build", "coder"],
							models: ["gpt-5.4", "gpt-5.3-codex"],
						},
					},
				},
				{ providers: {} },
			),
		).toBe("Fast Mode — all models OFF");

		expect(
			formatFastModeDialogTitle(
				{
					enabled: true,
					providers: {
						openai: {
							enabled: true,
							agents: ["build", "coder"],
							models: ["gpt-5.4", "gpt-5.3-codex"],
						},
					},
				},
				{ providers: { openai: { models: { "gpt-5.4": true } } } },
			),
		).toBe("Fast Mode — 1 model ON (openai/gpt-5.4)");
	});
});

describe("fast mode tui module export", () => {
	test("default export matches TuiPluginModule shape", async () => {
		const mod = await import("../tui/index.js");
		const plugin = mod.default as TuiPluginModule;

		expect(plugin).toBeDefined();
		expect(plugin.id).toBe("@op1/fast-mode");
		expect(typeof plugin.tui).toBe("function");
		expect(plugin.server).toBeUndefined();
	});
});

describe("installFastModePlugin", () => {
	test("registers route and command", async () => {
		const { installFastModePlugin } = await import("../tui/plugin.js");

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
		await installFastModePlugin(mockApi as any);

		expect(registeredRoutes).toHaveLength(1);
		expect((registeredRoutes[0] as { name: string }).name).toBe("fast-mode");
		expect(registeredCommands).toHaveLength(1);
		expect((registeredCommands[0] as { title: string }).title).toBe(
			"Fast Mode",
		);

		(registeredCommands[0] as { onSelect: () => void }).onSelect();
		expect(navigations).toEqual([{ name: "fast-mode", params: undefined }]);
	});

	test("route render opens a dialog for a ready workspace", async () => {
		const { installFastModePlugin } = await import("../tui/plugin.js");

		const registeredRoutes: Array<{ name: string; render: () => unknown }> = [];
		const dialogProps: Array<Record<string, unknown>> = [];

		const directory = await mkdtemp(join(tmpdir(), "op1-fast-mode-tui-"));
		await mkdir(join(directory, ".opencode"), { recursive: true });
		process.env.XDG_CONFIG_HOME = join(directory, "xdg");
		await mkdir(join(directory, "xdg", "opencode"), { recursive: true });
		await Bun.write(
			join(directory, "xdg", "opencode", "fast-mode.json"),
			JSON.stringify(
				{
					enabled: true,
					providers: {
						openai: {
							models: ["gpt-5.4", "gpt-5.3-codex"],
							agents: ["build", "coder"],
						},
					},
				},
				null,
				2,
			),
		);
		await Bun.write(
			join(directory, ".opencode", "fast-mode-state.json"),
			JSON.stringify(
				{ providers: { openai: { models: { "gpt-5.4": true } } } },
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
				DialogSelect: (props: Record<string, unknown>) => {
					dialogProps.push(props);
					return null;
				},
				toast: () => {},
				dialog: {
					replace: (render: () => unknown) => {
						render();
					},
					clear: () => {},
				},
			},
			state: {
				ready: true,
				path: {
					state: join(directory, ".opencode", "state.json"),
					config: join(directory, ".opencode", "config.json"),
					worktree: directory,
					directory,
				},
			},
			lifecycle: {
				signal: new AbortController().signal,
				onDispose: () => () => {},
			},
		};

		try {
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			await installFastModePlugin(mockApi as any);
			registeredRoutes[0]?.render();
			await flushMicrotasks();

			expect(dialogProps).toHaveLength(1);
			expect(dialogProps[0]?.title).toBe(
				"Fast Mode — 1 model ON (openai/gpt-5.4)",
			);
			expect(
				(dialogProps[0]?.options as Array<{ title: string }>).map(
					(option) => option.title,
				),
			).toEqual(["○ OFF gpt-5.3-codex", "● ON  gpt-5.4"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("route render warns when workspace directory is unavailable", async () => {
		const { installFastModePlugin } = await import("../tui/plugin.js");

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
				current: { name: "fast-mode", params: undefined },
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
		await installFastModePlugin(mockApi as any);
		registeredRoutes[0]?.render();
		await flushMicrotasks();

		expect(navigations).toContainEqual({ name: "home", params: undefined });
		expect(toasts).toContainEqual({
			variant: "warning",
			message: "Workspace directory not available yet.",
		});
	});
});
