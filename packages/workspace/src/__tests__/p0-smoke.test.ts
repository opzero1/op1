import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createContextScoutStateManager } from "../context-scout/state";
import { resolveDelegationRouting } from "../delegation/router";
import {
	buildHashAnchor,
	type HashAnchorContext,
} from "../hash-anchor/contract";
import { executeHashAnchoredEdit } from "../hash-anchor/edit";
import { loadHookConfig } from "../hooks/safe-hook";
import { WorkspacePlugin } from "../index";

const tempRoots: string[] = [];
const originalHome = Bun.env.HOME;

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;

	if (originalHome === undefined) {
		delete Bun.env.HOME;
	} else {
		Bun.env.HOME = originalHome;
	}
});

function createMockClient(
	sessionParents: Record<string, string | undefined> = {},
) {
	return {
		app: {
			log: async () => {},
		},
		session: {
			get: async (input: { path: { id: string } }) => {
				if (Object.hasOwn(sessionParents, input.path.id)) {
					const parentID = sessionParents[input.path.id];
					if (typeof parentID === "string") {
						return { data: { id: input.path.id, parentID } };
					}
				}

				return { data: { id: input.path.id } };
			},
			create: async () => ({ data: { id: "mock-child-session" } }),
			promptAsync: async () => ({}),
			messages: async () => ({ data: [] }),
			abort: async () => ({}),
		},
	};
}

function makeAnchors(content: string, lineNumbers: number[]): string[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	return lineNumbers.map((lineNumber) => {
		const context: HashAnchorContext = {
			previous: lines[lineNumber - 2],
			next: lines[lineNumber],
		};
		return buildHashAnchor(lineNumber, lines[lineNumber - 1] ?? "", context);
	});
}

describe("P0 feature smoke", () => {
	test("runs hash-anchor, context-scout, and router flows in one config", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-p0-smoke-"));
		tempRoots.push(root);

		const homeRoot = await mkdtemp(join(tmpdir(), "op1-p0-smoke-home-"));
		tempRoots.push(homeRoot);
		Bun.env.HOME = homeRoot;

		const opencodeDir = join(root, ".opencode");
		const workspaceDir = join(opencodeDir, "workspace");
		await mkdir(workspaceDir, { recursive: true });

		await Bun.write(
			join(opencodeDir, "workspace.json"),
			JSON.stringify(
				{
					features: {
						hashAnchoredEdit: true,
						contextScout: true,
					},
				},
				null,
				2,
			),
		);

		const hookConfig = await loadHookConfig(root);
		expect(hookConfig.features.hashAnchoredEdit).toBe(true);
		expect(hookConfig.features.contextScout).toBe(true);

		const targetFile = join(root, "target.ts");
		const initial = ["function get() {", "  return 1;", "}", ""].join("\n");
		await Bun.write(targetFile, initial);
		const hashResult = await executeHashAnchoredEdit(
			{
				filePath: "target.ts",
				anchors: makeAnchors(initial, [2]),
				replacement: "  return 2;",
			},
			{
				directory: root,
				enabled: hookConfig.features.hashAnchoredEdit,
			},
		);
		expect(hashResult.ok).toBe(true);

		const contextScout = createContextScoutStateManager(workspaceDir);
		const upsertSummary = await contextScout.upsertPatterns([
			{
				pattern: "task.*router",
				severity: "high",
				confidence: 0.93,
				source_tool: "grep",
				tags: ["task", "routing"],
			},
		]);
		expect(upsertSummary.total).toBeGreaterThan(0);
		const ranked = await contextScout.listRankedPatterns({ limit: 1 });
		expect(ranked[0]?.pattern).toBe("task.*router");

		const routed = resolveDelegationRouting({
			description: "Research API docs",
			prompt: "Investigate docs and compare approaches",
			autoRoute: true,
		});
		expect(routed.telemetry.detected_category).toBe("research");

		const override = resolveDelegationRouting({
			description: "Use explicit subagent",
			prompt: "Investigate and summarize",
			autoRoute: true,
			subagentType: "reviewer",
		});
		expect(override.agent).toBe("reviewer");

		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient(),
		} as never);
		const planPromoteTool = plugin.tool?.plan_promote;
		const planContextReadTool = plugin.tool?.plan_context_read;
		const planContextWriteTool = plugin.tool?.plan_context_write;
		const planReadTool = plugin.tool?.plan_read as
			| {
					execute: (
						args: { reason: string },
						toolCtx: unknown,
					) => Promise<string>;
			  }
			| undefined;
		expect(planPromoteTool).toBeDefined();
		expect(planContextReadTool).toBeDefined();
		expect(planContextWriteTool).toBeDefined();
		expect(planReadTool).toBeDefined();
		if (!planReadTool) {
			throw new Error("plan_read tool is missing in smoke scenario");
		}

		const planReadResult = await planReadTool.execute(
			{ reason: "smoke test" },
			{ sessionID: "smoke-session" },
		);
		expect(planReadResult).toMatch(/No plan/);
	});
});
