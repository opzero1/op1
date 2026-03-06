import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { loadHookConfig } from "../hooks/safe-hook";
import { WorkspacePlugin } from "../index";
import { runCommand } from "../utils";

const tempRoots: string[] = [];
const originalHome = Bun.env.HOME;

type ContinuationContinueTool = {
	execute: (
		args: { session_id?: string; idempotency_key?: string },
		toolCtx: { sessionID?: string },
	) => Promise<string>;
};

type WorktreeCreateTool = {
	execute: (
		args: { branch: string; open_terminal?: boolean },
		toolCtx: { sessionID?: string },
	) => Promise<string>;
};

type WorktreeDeleteTool = {
	execute: (
		args: { branch: string; snapshot?: boolean; force?: boolean },
		toolCtx: { sessionID?: string },
	) => Promise<string>;
};

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

function createMockClient(sessionParents: Record<string, string | undefined>) {
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

async function setupGitRepository(root: string): Promise<void> {
	await runCommand(["git", "init"], root);
	await runCommand(["git", "config", "user.email", "test@example.com"], root);
	await runCommand(["git", "config", "user.name", "OP7 Test"], root);
	await Bun.write(join(root, "README.md"), "# p1 smoke\n");
	await runCommand(["git", "add", "README.md"], root);
	await runCommand(["git", "commit", "-m", "init"], root);
}

describe("P1 feature smoke", () => {
	test("runs boundary + continuation + externalScout + tmux orchestration in one config", async () => {
		const homeRoot = await mkdtemp(join(tmpdir(), "op1-p1-smoke-home-"));
		tempRoots.push(homeRoot);
		Bun.env.HOME = homeRoot;

		const root = await mkdtemp(join(tmpdir(), "op1-p1-smoke-"));
		tempRoots.push(root);

		const opencodeDir = join(root, ".opencode");
		const workspaceDir = join(opencodeDir, "workspace");
		await mkdir(workspaceDir, { recursive: true });

		await Bun.write(
			join(opencodeDir, "workspace.json"),
			JSON.stringify(
				{
					features: {
						boundaryPolicyV2: true,
						taskGraph: true,
						continuationCommands: true,
						externalScout: true,
						tmuxOrchestration: true,
					},
				},
				null,
				2,
			),
		);

		await setupGitRepository(root);

		const hookConfig = await loadHookConfig(root);
		expect(hookConfig.features.boundaryPolicyV2).toBe(true);
		expect(hookConfig.features.taskGraph).toBe(true);
		expect(hookConfig.features.continuationCommands).toBe(true);
		expect(hookConfig.features.externalScout).toBe(true);
		expect(hookConfig.features.contextScout).toBe(true);
		expect(hookConfig.features.tmuxOrchestration).toBe(true);

		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient({
				"child-session": "root-session",
				"root-session": undefined,
			}),
		} as never);

		const continuationContinue = plugin.tool
			?.continuation_continue as unknown as ContinuationContinueTool;
		const worktreeCreate = plugin.tool
			?.worktree_create as unknown as WorktreeCreateTool;
		const worktreeDelete = plugin.tool
			?.worktree_delete as unknown as WorktreeDeleteTool;

		expect(continuationContinue).toBeDefined();
		expect(worktreeCreate).toBeDefined();
		expect(worktreeDelete).toBeDefined();

		const blockedTransition = await continuationContinue.execute(
			{},
			{ sessionID: "child-session" },
		);
		expect(blockedTransition).toContain("requires idempotency_key");

		const runningTransition = await continuationContinue.execute(
			{ idempotency_key: "p1-smoke-key" },
			{ sessionID: "child-session" },
		);
		expect(runningTransition).toContain('"mode": "running"');

		const branch = "feature/p1-smoke";
		const created = await worktreeCreate.execute(
			{ branch, open_terminal: false },
			{ sessionID: "child-session" },
		);
		expect(created).toContain("✅ Worktree created");

		const deleted = await worktreeDelete.execute(
			{ branch, snapshot: false, force: true },
			{ sessionID: "child-session" },
		);
		expect(deleted).toContain("✅ Worktree deleted");
	});
});
