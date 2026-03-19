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

afterEach(async () => {
	process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots.length = 0;
});

describe("reprompt integration", () => {
	test("loads and merges global and project reprompt config", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-config-"));
		tempRoots.push(root);
		const xdgRoot = join(root, "xdg");
		await mkdir(join(xdgRoot, "opencode"), { recursive: true });
		await mkdir(join(root, ".opencode"), { recursive: true });
		await Bun.write(
			join(xdgRoot, "opencode", "reprompt.json"),
			JSON.stringify({ enabled: true, runtime: { killSwitch: true } }),
		);
		await Bun.write(
			join(root, ".opencode", "reprompt.json"),
			JSON.stringify({
				runtime: { killSwitch: false },
				telemetry: { level: "debug" },
			}),
		);

		process.env.XDG_CONFIG_HOME = xdgRoot;
		const config = await loadRepromptConfig(root);

		expect(config.enabled).toBe(true);
		expect(config.runtime.killSwitch).toBe(false);
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

	test("plugin exposes helper tools without hook auto-reprompt wiring", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-plugin-"));
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

		expect(hooks.tool).toBeDefined();
		expect(hooks.tool?.reprompt_retry).toBeDefined();
		expect((hooks as Record<string, unknown>)["chat.message"]).toBeUndefined();
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

		const tool = tools.reprompt_retry as unknown as {
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

		const tool = tools.reprompt_retry as unknown as {
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

		const tool = tools.reprompt_retry as unknown as {
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

		const tool = tools.reprompt_retry as unknown as {
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

	test("helper tool respects kill switch fallback", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-killswitch-"));
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
					killSwitch: true,
				},
			},
		});
		const tool = tools.reprompt_retry as unknown as {
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

		expect(result).toBe("reprompt suppressed: kill switch is enabled");
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

		const tool = tools.reprompt_retry as unknown as {
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

		const tool = tools.reprompt_retry as unknown as {
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
		expect(result).toContain("Evidence slices:");
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

		const tool = tools.reprompt_retry as unknown as {
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

	test("legacy prompt mode preserves the v1 prompt shape", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-reprompt-legacy-"));
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
					promptMode: "legacy",
					killSwitch: false,
				},
			},
		});

		const tool = tools.reprompt_retry as unknown as {
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

		expect(result).toContain("prompt_mode: legacy");
		expect(result).toContain("Task summary: inspect file");
		expect(result).not.toContain("<output_contract>");
	});
});
