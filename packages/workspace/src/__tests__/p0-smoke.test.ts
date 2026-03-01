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
import { createSkillPointerResolver } from "../skill-pointer/resolve";

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

async function writeSkillPointerFixture(skillsRoot: string): Promise<void> {
	const pointerDir = join(skillsRoot, ".skillpointer");
	const vaultRoot = join(skillsRoot, "skill-vault");
	const vaultSkillPath = join(vaultRoot, "researcher", "SKILL.md");
	const vaultContent = "Researcher vault guidance";

	await mkdir(pointerDir, { recursive: true });
	await mkdir(join(vaultRoot, "researcher"), { recursive: true });
	await Bun.write(vaultSkillPath, vaultContent);

	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(vaultContent);
	const checksum = hasher.digest("hex");

	await Bun.write(
		join(pointerDir, "index.json"),
		JSON.stringify(
			{
				version: 1,
				vault_root: vaultRoot,
				categories: [
					{
						category: "research",
						skills: [
							{
								name: "researcher",
								checksum_sha256: checksum,
								vault_path: "researcher/SKILL.md",
							},
						],
					},
				],
			},
			null,
			2,
		),
	);
}

describe("P0 feature smoke", () => {
	test("runs hash-anchor, context-scout, skill-pointer, router, and approval flows in one config", async () => {
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
						skillPointer: true,
						approvalGate: true,
					},
					approval: {
						mode: "selected",
						tools: ["plan_archive"],
						nonInteractive: "fail-closed",
					},
				},
				null,
				2,
			),
		);

		const skillsRoot = join(homeRoot, ".config", "opencode", "skills");
		await writeSkillPointerFixture(skillsRoot);

		const hookConfig = await loadHookConfig(root);
		expect(hookConfig.features.hashAnchoredEdit).toBe(true);
		expect(hookConfig.features.contextScout).toBe(true);
		expect(hookConfig.features.skillPointer).toBe(true);
		expect(hookConfig.features.approvalGate).toBe(true);

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
				pattern: "delegate.*router",
				severity: "high",
				confidence: 0.93,
				source_tool: "grep",
				tags: ["delegation", "routing"],
			},
		]);
		expect(upsertSummary.total).toBeGreaterThan(0);
		const ranked = await contextScout.listRankedPatterns({ limit: 1 });
		expect(ranked[0]?.pattern).toBe("delegate.*router");

		const skillPointerResolver = createSkillPointerResolver({
			enabled: hookConfig.features.skillPointer,
			skillsRoot,
		});
		const integrity = await skillPointerResolver.validateIndex();
		expect(integrity.ok).toBe(true);
		const resolvedSkill =
			await skillPointerResolver.resolveSkillBody("researcher");
		expect(resolvedSkill.source).toBe("vault");
		expect(resolvedSkill.content).toContain("Researcher vault guidance");

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
		const planArchiveTool = plugin.tool?.plan_archive as
			| {
					execute: (
						args: { identifier: string },
						toolCtx: unknown,
					) => Promise<string>;
			  }
			| undefined;
		expect(planArchiveTool).toBeDefined();
		if (!planArchiveTool) {
			throw new Error("plan_archive tool is missing in smoke scenario");
		}

		const approvalResult = await planArchiveTool.execute(
			{ identifier: "missing-plan" },
			{ sessionID: "smoke-session" },
		);
		expect(approvalResult).toContain("approval-gated");
		expect(approvalResult).toContain("prompts are unavailable");
	});
});
