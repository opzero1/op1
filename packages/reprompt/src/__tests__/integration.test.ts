import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepromptConfig } from "../config.js";
import { createPublicRepromptTools } from "../orchestration/public-tools.js";
import { RepromptPlugin } from "../plugin.js";
import { buildCodeMapLite } from "../serializer/codemap-lite.js";
import { collectRepoSnapshot } from "../serializer/repo-snapshot.js";

const tempRoots: string[] = [];
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const REPROMPT_MARKER = '<reprompt-origin source="reprompt" />';

afterEach(async () => {
	process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots.length = 0;
});

function createPluginClient() {
	return {
		session: {
			create: async () => ({ data: { id: "child" } }),
			prompt: async () => ({
				data: { parts: [{ type: "text", text: "ok" }] },
			}),
		},
	};
}

async function createPluginWithConfig(
	root: string,
	config: Record<string, unknown>,
) {
	await mkdir(join(root, ".opencode"), { recursive: true });
	await Bun.write(
		join(root, ".opencode", "reprompt.json"),
		JSON.stringify(config),
	);

	return RepromptPlugin({
		directory: root,
		worktree: root,
		project: {} as never,
		serverUrl: new URL("http://localhost:4096"),
		$: {} as never,
		client: createPluginClient() as never,
	});
}

describe("reprompt integration", () => {
	test("loads and merges global and project reprompt config", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-config-"));
		tempRoots.push(root);
		const xdgRoot = join(root, "xdg");
		await mkdir(join(xdgRoot, "opencode"), { recursive: true });
		await mkdir(join(root, ".opencode"), { recursive: true });
		await Bun.write(
			join(xdgRoot, "opencode", "reprompt.json"),
			JSON.stringify({ enabled: true, runtime: { mode: "helper-only" } }),
		);
		await Bun.write(
			join(root, ".opencode", "reprompt.json"),
			JSON.stringify({
				runtime: { mode: "hook-and-helper" },
				telemetry: { level: "debug" },
			}),
		);

		process.env.XDG_CONFIG_HOME = xdgRoot;
		const config = await loadRepromptConfig(root);

		expect(config.enabled).toBe(true);
		expect(config.runtime.mode).toBe("hook-and-helper");
		expect(config.runtime.triggerPrefix).toBe("opx");
		expect(config.telemetry.level).toBe("debug");
	});

	test("invalid config fails closed by disabling the plugin", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-invalid-config-"));
		tempRoots.push(root);
		const xdgRoot = join(root, "xdg");
		await mkdir(join(xdgRoot, "opencode"), { recursive: true });
		await Bun.write(
			join(xdgRoot, "opencode", "reprompt.json"),
			"{ invalid json",
		);

		process.env.XDG_CONFIG_HOME = xdgRoot;
		const config = await loadRepromptConfig(root);

		expect(config.enabled).toBe(false);
	});

	test("uses optional code-intel adapter for codemap enrichment", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-codemap-"));
		tempRoots.push(root);
		await Bun.write(join(root, "main.ts"), "export function run() {}\n");

		const snapshot = await collectRepoSnapshot(root);
		const codemap = await buildCodeMapLite(root, snapshot, {
			adapter: {
				async getSummaries() {
					return [
						{
							path: "main.ts",
							importanceScore: 99,
							symbolSummary: ["run"],
						},
					];
				},
			},
		});

		expect(codemap.usedCodeIntel).toBe(true);
		expect(codemap.files[0]?.provenance).toBe("code-intel");
		expect(codemap.files[0]?.symbols).toContain("run");
	});

	test("plugin exposes helper tools and incoming hook when enabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-plugin-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode"), { recursive: true });
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		await Bun.write(
			join(root, ".opencode", "reprompt.json"),
			JSON.stringify({ enabled: true }),
		);

		const hooks = await RepromptPlugin({
			directory: root,
			worktree: root,
			project: {} as never,
			serverUrl: new URL("http://localhost:4096"),
			$: {} as never,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
		});

		expect(hooks.tool).toBeDefined();
		expect(hooks.tool?.reprompt).toBeDefined();
		expect((hooks as Record<string, unknown>)["chat.message"]).toBeDefined();

		const chatMessage = (hooks as Record<string, unknown>)["chat.message"] as (
			input: Record<string, unknown>,
			output: {
				message: Record<string, unknown>;
				parts: Array<{ type: string; text?: string }>;
			},
		) => Promise<void>;
		const output = {
			message: { content: "opx fix src.ts" },
			parts: [
				{
					id: "part-1",
					sessionID: "root-session",
					messageID: "msg-1",
					type: "text",
					text: "opx fix src.ts",
				},
			],
		};

		await chatMessage(
			{
				sessionID: "root-session",
				messageID: "msg-1",
			},
			output,
		);

		expect(output.parts[0]?.text).toContain(
			'<reprompt-origin source="reprompt" />',
		);
		expect(output.parts[0]?.text).toContain("fix src.ts");
		expect(output.parts[0]?.id).toBe("part-1");
		expect(output.parts[0]?.sessionID).toBe("root-session");
		expect(output.parts[0]?.messageID).toBe("msg-1");
		expect(output.message.content).toBe("opx fix src.ts");

		const childOutput = {
			message: { content: "opx fix src.ts" },
			parts: [{ type: "text", text: "opx fix src.ts" }],
		};
		await chatMessage({ sessionID: "child-session" }, childOutput);

		expect(childOutput.parts[0]?.text).toContain(
			'<reprompt-origin source="reprompt" />',
		);
		expect(childOutput.message.content).toBe("opx fix src.ts");
	});

	test("incoming hook passes through reprompt-origin prompts", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "op1-reprompt-hook-pass-through-"),
		);
		tempRoots.push(root);
		await mkdir(join(root, ".opencode"), { recursive: true });
		await Bun.write(
			join(root, ".opencode", "reprompt.json"),
			JSON.stringify({ enabled: true }),
		);

		const hooks = await RepromptPlugin({
			directory: root,
			worktree: root,
			project: {} as never,
			serverUrl: new URL("http://localhost:4096"),
			$: {} as never,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
		});

		const chatMessage = (hooks as Record<string, unknown>)["chat.message"] as (
			input: Record<string, unknown>,
			output: {
				message: Record<string, unknown>;
				parts: Array<{ type: string; text?: string }>;
			},
		) => Promise<void>;
		const prompt = '<reprompt-origin source="reprompt" />\n\ncompiled prompt';
		const output = {
			message: {},
			parts: [{ type: "text", text: prompt }],
		};

		await chatMessage({ sessionID: "child-session" }, output);

		expect(output.parts[0]?.text).toBe(prompt);
	});

	test("incoming hook passes through casual first prompts unchanged", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-casual-"));
		tempRoots.push(root);
		await mkdir(join(root, ".opencode"), { recursive: true });
		await Bun.write(
			join(root, ".opencode", "reprompt.json"),
			JSON.stringify({ enabled: true }),
		);

		const hooks = await RepromptPlugin({
			directory: root,
			worktree: root,
			project: {} as never,
			serverUrl: new URL("http://localhost:4096"),
			$: {} as never,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
		});

		const chatMessage = (hooks as Record<string, unknown>)["chat.message"] as (
			input: Record<string, unknown>,
			output: {
				message: Record<string, unknown>;
				parts: Array<{ type: string; text?: string }>;
			},
		) => Promise<void>;
		const output = {
			message: { content: "hi" },
			parts: [{ type: "text", text: "hi" }],
		};

		await chatMessage(
			{ sessionID: "casual-session", messageID: "msg-1" },
			output,
		);

		expect(output.parts[0]?.text).toBe("hi");
		expect(output.message.content).toBe("hi");
	});

	test("plugin skips incoming hook registration in helper-only mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-helper-only-"));
		tempRoots.push(root);

		const hooks = await createPluginWithConfig(root, {
			enabled: true,
			runtime: { mode: "helper-only" },
		});

		expect(hooks.tool?.reprompt).toBeDefined();
		expect((hooks as Record<string, unknown>)["chat.message"]).toBeUndefined();
	});

	test("incoming hook passes through structured first prompts unchanged", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-structured-"));
		tempRoots.push(root);
		await Bun.write(join(root, "auth.ts"), "export const value = 1\n");

		const hooks = await createPluginWithConfig(root, {
			enabled: true,
			runtime: { mode: "hook-and-helper" },
		});
		const chatMessage = (hooks as Record<string, unknown>)["chat.message"] as (
			input: Record<string, unknown>,
			output: {
				message: Record<string, unknown>;
				parts: Array<{ type: string; text?: string }>;
			},
		) => Promise<void>;
		const prompt = [
			"## Goal",
			"- Update auth flow in `auth.ts`",
			"- Run focused tests afterward",
		].join("\n");
		const output = {
			message: { content: prompt },
			parts: [{ type: "text", text: prompt }],
		};

		await chatMessage({ sessionID: "structured-session" }, output);

		expect(output.parts[0]?.text).toBe(prompt);
		expect(output.message.content).toBe(prompt);
	});

	test("incoming hook passes through non-text first prompts unchanged", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-non-text-"));
		tempRoots.push(root);

		const hooks = await createPluginWithConfig(root, {
			enabled: true,
			runtime: { mode: "hook-and-helper" },
		});
		const chatMessage = (hooks as Record<string, unknown>)["chat.message"] as (
			input: Record<string, unknown>,
			output: {
				message: Record<string, unknown>;
				parts: Array<{ type: string; text?: string; file?: string }>;
			},
		) => Promise<void>;
		const output = {
			message: {},
			parts: [{ type: "image", file: "diagram.png" }],
		};

		await chatMessage({ sessionID: "non-text-session" }, output);

		expect(output.parts).toEqual([{ type: "image", file: "diagram.png" }]);
	});

	test("incoming hook only rewrites the first message per session", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-first-only-"));
		tempRoots.push(root);
		await Bun.write(join(root, "auth.ts"), "export const value = 1\n");

		const hooks = await createPluginWithConfig(root, {
			enabled: true,
			runtime: { mode: "hook-and-helper" },
		});
		const chatMessage = (hooks as Record<string, unknown>)["chat.message"] as (
			input: Record<string, unknown>,
			output: {
				message: Record<string, unknown>;
				parts: Array<{ type: string; text?: string }>;
			},
		) => Promise<void>;

		const first = {
			message: { content: "opx fix auth.ts" },
			parts: [{ type: "text", text: "opx fix auth.ts" }],
		};
		await chatMessage({ sessionID: "single-session" }, first);
		expect(first.parts[0]?.text).toContain(REPROMPT_MARKER);

		const secondPrompt = "opx fix billing.ts";
		const second = {
			message: { content: secondPrompt },
			parts: [{ type: "text", text: secondPrompt }],
		};
		await chatMessage({ sessionID: "single-session" }, second);

		expect(second.parts[0]?.text).toBe(secondPrompt);
		expect(second.message.content).toBe(secondPrompt);
	});

	test("incoming hook fails closed for ambiguous terse prompts", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-fail-closed-"));
		tempRoots.push(root);

		const hooks = await createPluginWithConfig(root, {
			enabled: true,
			runtime: { mode: "hook-and-helper" },
		});
		const chatMessage = (hooks as Record<string, unknown>)["chat.message"] as (
			input: Record<string, unknown>,
			output: {
				message: Record<string, unknown>;
				parts: Array<{ type: string; text?: string }>;
			},
		) => Promise<void>;
		const output = {
			message: { content: "opx fix it" },
			parts: [{ type: "text", text: "opx fix it" }],
		};

		await chatMessage({ sessionID: "ambiguous-session" }, output);

		expect(output.parts[0]?.text).toContain(REPROMPT_MARKER);
		expect(output.parts[0]?.text).toContain("<fail_closed_instructions>");
		expect(output.parts[0]?.text).toContain(
			"Ask exactly one targeted clarification question",
		);
	});

	test("helper tool executes child-session retry when execute=true", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-execute-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		const client = {
			session: {
				create: async () => ({ data: { id: "child-session" } }),
				prompt: async () => ({
					data: { parts: [{ type: "text", text: "child-result" }] },
				}),
			},
		};

		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: client as never,
			config: { enabled: true, retry: { maxAttempts: 2, cooldownMs: 0 } },
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: {
					task_summary: string;
					failure_summary: string;
					evidence_paths: string[];
					execute: boolean;
				},
				ctx: {
					sessionID: string;
					messageID: string;
					agent: string;
					directory: string;
					worktree: string;
					callID: string;
					abort: AbortSignal;
					ask: (...args: unknown[]) => Promise<void>;
					metadata: (...args: unknown[]) => Promise<void>;
				},
			) => Promise<string>;
		};

		const result = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: true,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				ask: async () => {},
				metadata: async () => {},
			},
		);

		expect(result).toContain("decision: retry-helper");
		expect(result).toContain("child-result");
	});

	test("helper tool reports child-session creation failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-create-fail-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => ({ data: {} }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "unused" }] },
					}),
				},
			} as never,
			config: { enabled: true, retry: { maxAttempts: 2 } },
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};

		const result = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: true,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				ask: async () => {},
				metadata: async () => {},
			},
		);

		expect(result).toBe("reprompt failed: could not create child session");
	});

	test("guard cleanup runs even when child-session creation throws", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-create-throw-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		let throws = true;
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => {
						if (throws) {
							throws = false;
							throw new Error("create-failed");
						}
						return { data: { id: "child-session" } };
					},
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
			config: { enabled: true, retry: { maxAttempts: 2, cooldownMs: 0 } },
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};
		const ctx = {
			sessionID: "parent",
			messageID: "msg",
			agent: "build",
			directory: root,
			worktree: root,
			callID: "call",
			abort: new AbortController().signal,
			ask: async () => {},
			metadata: async () => {},
		};

		const first = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: true,
			},
			ctx,
		);
		const second = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: true,
			},
			ctx,
		);

		expect(first).toContain("reprompt execution failed: create-failed");
		expect(second).toContain("decision: retry-helper");
		expect(second).toContain("ok");
	});

	test("helper tool surfaces child-session execution errors", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-prompt-fail-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => ({ data: { id: "child-session" } }),
					prompt: async () => ({ error: "child-boom", data: { parts: [] } }),
				},
			} as never,
			config: { enabled: true },
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};

		const result = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: true,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				ask: async () => {},
				metadata: async () => {},
			},
		);

		expect(result).toContain("reprompt execution failed: child-boom");
	});

	test("helper tool stays available in helper-only mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-helper-only-"));
		tempRoots.push(root);
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
			config: {
				enabled: true,
				runtime: {
					mode: "helper-only",
					promptMode: "auto",
				},
			},
		});
		const tool = tools.reprompt as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};

		const result = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "kill switch",
				evidence_paths: ["src.ts"],
				execute: false,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				ask: async () => {},
				metadata: async () => {},
			},
		);

		expect(result).toContain("decision:");
	});

	test("helper tool guard state is isolated per session", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-session-guard-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
			config: {
				enabled: true,
				retry: { maxAttempts: 1, cooldownMs: 60_000 },
			},
		});
		const tool = tools.reprompt as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};

		const args = {
			task_summary: "inspect file",
			failure_summary: "need one bounded retry",
			evidence_paths: ["src.ts"],
			execute: false,
		};
		const first = await tool.execute(args, {
			sessionID: "session-a",
			messageID: "msg-a",
			agent: "build",
			directory: root,
			worktree: root,
			callID: "call-a",
			abort: new AbortController().signal,
			ask: async () => {},
			metadata: async () => {},
		});
		const second = await tool.execute(args, {
			sessionID: "session-b",
			messageID: "msg-b",
			agent: "build",
			directory: root,
			worktree: root,
			callID: "call-b",
			abort: new AbortController().signal,
			ask: async () => {},
			metadata: async () => {},
		});

		expect(first).toContain("decision:");
		expect(second).toContain("decision:");
		expect(second).not.toContain("cooldown-active");
	});

	test("telemetry persistence can be disabled explicitly", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-no-telemetry-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
			config: {
				enabled: true,
				telemetry: { persistEvents: false },
			},
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};

		await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: false,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				ask: async () => {},
				metadata: async () => {},
			},
		);

		const telemetryFile = Bun.file(
			join(root, ".opencode", "reprompt", "events.jsonl"),
		);
		expect(await telemetryFile.exists()).toBe(false);
	});

	test("public helper tool previews bounded retry prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-tool-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		const client = {
			session: {
				create: async () => ({ data: { id: "child" } }),
				prompt: async () => ({
					data: { parts: [{ type: "text", text: "ok" }] },
				}),
			},
		};

		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: client as never,
			config: { enabled: true },
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: {
					task_summary: string;
					failure_summary: string;
					evidence_paths: string[];
					execute: boolean;
				},
				ctx: {
					sessionID: string;
					messageID: string;
					agent: string;
					directory: string;
					worktree: string;
					callID: string;
					abort: AbortSignal;
					ask: (...args: unknown[]) => Promise<void>;
					metadata: (...args: unknown[]) => Promise<void>;
				},
			) => Promise<string>;
		};

		const result = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: false,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				ask: async () => {},
				metadata: async () => {},
			},
		);

		expect(result).toContain("decision: retry-helper");
		expect(result).toContain("prompt_mode: compiler");
		expect(result).toContain("<grounding_context>");
	});

	test("compiler mode previews a GPT-5.4-ready prompt from a simple prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-compiler-"));
		tempRoots.push(root);
		await Bun.write(
			join(root, "src.ts"),
			"export class AuthService {\n  createSession() {}\n}\n",
		);
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
			config: { enabled: true },
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: {
					simple_prompt: string;
					evidence_paths: string[];
					execute: boolean;
					success_criteria: string[];
				},
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};

		const result = await tool.execute(
			{
				simple_prompt: "fix AuthService createSession and verify the behavior",
				evidence_paths: ["src.ts"],
				success_criteria: ["Update AuthService", "Run verification"],
				execute: false,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				metadata: async () => {},
				ask: async () => {},
			},
		);

		expect(result).toContain("prompt_mode: compiler");
		expect(result).toContain("task_class: debug");
		expect(result).toContain("<output_contract>");
		expect(result).toContain("<grounding_context>");
		expect(result).toContain("Update AuthService");

		const telemetryFile = Bun.file(
			join(root, ".opencode", "reprompt", "events.jsonl"),
		);
		expect(await telemetryFile.exists()).toBe(true);
		const telemetry = await telemetryFile.text();
		expect(telemetry).toContain('"promptMode":"compiler"');
	});

	test("compiler mode is the only supported prompt shape", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-compiler-only-"));
		tempRoots.push(root);
		await Bun.write(join(root, "src.ts"), "export const value = 1\n");
		const tools = createPublicRepromptTools({
			workspaceRoot: root,
			client: {
				session: {
					create: async () => ({ data: { id: "child" } }),
					prompt: async () => ({
						data: { parts: [{ type: "text", text: "ok" }] },
					}),
				},
			} as never,
			config: {
				enabled: true,
				runtime: {
					mode: "helper-only",
					promptMode: "compiler",
				},
			},
		});

		const tool = tools.reprompt as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: Record<string, unknown>,
			) => Promise<string>;
		};

		const result = await tool.execute(
			{
				task_summary: "inspect file",
				failure_summary: "need one bounded retry",
				evidence_paths: ["src.ts"],
				execute: false,
			},
			{
				sessionID: "parent",
				messageID: "msg",
				agent: "build",
				directory: root,
				worktree: root,
				callID: "call",
				abort: new AbortController().signal,
				ask: async () => {},
				metadata: async () => {},
			},
		);

		expect(result).toContain("prompt_mode: compiler");
		expect(result).toContain("<output_contract>");
	});
});
