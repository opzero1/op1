import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadFastModeConfig,
	mergeFastModeConfigInput,
	parseFastModeConfig,
} from "../config.js";
import { applyFastModeServiceTier, shouldApplyFastMode } from "../runtime.js";
import {
	disableAllAgentFastMode,
	getEnabledAgents,
	loadFastModeState,
	parseFastModeState,
	saveFastModeState,
	setAgentFastModeEnabled,
} from "../state.js";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((rootPath) =>
			rm(rootPath, {
				recursive: true,
				force: true,
			}),
		),
	);
	tempRoots.length = 0;
	delete process.env.XDG_CONFIG_HOME;
});

describe("fast mode config", () => {
	test("parses safe disabled defaults", () => {
		const config = parseFastModeConfig({});
		expect(config.enabled).toBe(false);
		expect(config.providers).toEqual({});
	});

	test("normalizes provider and allowlist values", () => {
		const config = parseFastModeConfig({
			enabled: true,
			providers: {
				OpenAI: {
					agents: ["Coder", " coder "],
					models: ["gpt-5.3-codex", " gpt-5.3-codex "],
				},
			},
		});

		expect(config.enabled).toBe(true);
		expect(Object.keys(config.providers)).toEqual(["openai"]);
		expect(config.providers.openai?.agents).toEqual(["coder"]);
		expect(config.providers.openai?.models).toEqual(["gpt-5.3-codex"]);
	});

	test("merges global and project config at provider level", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-fast-mode-config-"));
		tempRoots.push(root);

		const workspaceRoot = join(root, "workspace");
		const xdgRoot = join(root, "xdg");
		process.env.XDG_CONFIG_HOME = xdgRoot;

		await Bun.write(
			join(xdgRoot, "opencode", "fast-mode.json"),
			JSON.stringify(
				{
					enabled: true,
					providers: {
						openai: {
							agents: ["build"],
							models: ["gpt-5.3-codex"],
						},
					},
				},
				null,
				2,
			),
		);

		await Bun.write(
			join(workspaceRoot, ".opencode", "fast-mode.json"),
			JSON.stringify(
				{
					providers: {
						openai: {
							agents: ["coder"],
						},
					},
				},
				null,
				2,
			),
		);

		const config = await loadFastModeConfig(workspaceRoot);
		expect(config.enabled).toBe(true);
		expect(config.providers.openai?.agents).toEqual(["coder"]);
		expect(config.providers.openai?.models).toEqual(["gpt-5.3-codex"]);
	});

	test("fails closed when config file is invalid json", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-fast-mode-invalid-"));
		tempRoots.push(root);

		process.env.XDG_CONFIG_HOME = join(root, "xdg");
		await Bun.write(
			join(root, "workspace", ".opencode", "fast-mode.json"),
			"{",
		);

		const config = await loadFastModeConfig(join(root, "workspace"));
		expect(config.enabled).toBe(false);
		expect(config.providers).toEqual({});
	});

	test("merge helper keeps nested provider keys", () => {
		const merged = mergeFastModeConfigInput(
			{
				enabled: true,
				providers: {
					openai: {
						agents: ["build"],
						models: ["gpt-5.3-codex"],
					},
				},
			},
			{
				providers: {
					openai: {
						agents: ["coder"],
					},
				},
			},
		);

		expect(merged.providers?.openai?.agents).toEqual(["coder"]);
		expect(merged.providers?.openai?.models).toEqual(["gpt-5.3-codex"]);
	});
});

describe("fast mode state", () => {
	test("loads default state and persists toggles", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-fast-mode-state-"));
		tempRoots.push(root);

		const workspaceRoot = join(root, "workspace");
		const initial = await loadFastModeState(workspaceRoot);
		expect(initial.agents).toEqual({});

		const enabled = setAgentFastModeEnabled(initial, "Coder", true);
		await saveFastModeState(workspaceRoot, enabled);

		const reloaded = await loadFastModeState(workspaceRoot);
		expect(reloaded.agents).toEqual({ coder: true });
		expect(getEnabledAgents(reloaded)).toEqual(["coder"]);

		const disabled = setAgentFastModeEnabled(reloaded, "coder", false);
		expect(disabled.agents).toEqual({});
	});

	test("clears all enabled agents", () => {
		const state = parseFastModeState({
			agents: {
				build: true,
				coder: true,
			},
		});

		expect(disableAllAgentFastMode()).toEqual({ agents: {} });
		expect(getEnabledAgents(state)).toEqual(["build", "coder"]);
	});
});

describe("fast mode request mutation", () => {
	test("applies priority service tier only for allowed and enabled request", () => {
		const config = parseFastModeConfig({
			enabled: true,
			providers: {
				openai: {
					agents: ["coder"],
					models: ["gpt-5.3-codex"],
				},
			},
		});
		const state = parseFastModeState({
			agents: {
				coder: true,
			},
		});

		expect(
			shouldApplyFastMode({
				config,
				state,
				request: {
					providerID: "openai",
					modelID: "gpt-5.3-codex",
					agentName: "coder",
				},
			}),
		).toBe(true);

		const output = {
			options: {},
		};
		applyFastModeServiceTier(output);
		expect(output.options).toEqual({ serviceTier: "priority" });
	});

	test("fails closed for disallowed model, provider, or agent toggle", () => {
		const config = parseFastModeConfig({
			enabled: true,
			providers: {
				openai: {
					agents: ["coder"],
					models: ["gpt-5.3-codex"],
				},
			},
		});
		const disabledState = parseFastModeState({ agents: {} });

		expect(
			shouldApplyFastMode({
				config,
				state: disabledState,
				request: {
					providerID: "openai",
					modelID: "gpt-5.3-codex",
					agentName: "coder",
				},
			}),
		).toBe(false);

		expect(
			shouldApplyFastMode({
				config,
				state: parseFastModeState({ agents: { coder: true } }),
				request: {
					providerID: "openai",
					modelID: "gpt-5.4",
					agentName: "coder",
				},
			}),
		).toBe(false);

		expect(
			shouldApplyFastMode({
				config,
				state: parseFastModeState({ agents: { coder: true } }),
				request: {
					providerID: "anthropic",
					modelID: "gpt-5.3-codex",
					agentName: "coder",
				},
			}),
		).toBe(false);
	});
});
