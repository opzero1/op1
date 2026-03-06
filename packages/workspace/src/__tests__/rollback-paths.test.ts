import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { loadHookConfig } from "../hooks/safe-hook";
import { WorkspacePlugin } from "../index";

const tempRoots: string[] = [];

type ContinuationContinueTool = {
	execute: (
		args: { session_id?: string; idempotency_key?: string },
		toolCtx: { sessionID?: string },
	) => Promise<string>;
};

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

function createMockClient() {
	return {
		app: {
			log: async () => {},
		},
		session: {
			get: async (input: { path: { id: string } }) => ({
				data: { id: input.path.id },
			}),
			create: async () => ({ data: { id: "mock-child-session" } }),
			promptAsync: async () => ({}),
			messages: async () => ({ data: [] }),
			abort: async () => ({}),
		},
	};
}

describe("P1 rollback paths", () => {
	test("disables continuation commands when feature flags are off", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-rollback-paths-test-"));
		tempRoots.push(root);

		const opencodeDir = join(root, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await Bun.write(
			join(opencodeDir, "workspace.json"),
			JSON.stringify(
				{
					features: {
						taskGraph: false,
						continuationCommands: false,
						contextScout: false,
						externalScout: false,
						tmuxOrchestration: false,
						boundaryPolicyV2: false,
					},
				},
				null,
				2,
			),
		);

		const hookConfig = await loadHookConfig(root);
		expect(hookConfig.features.taskGraph).toBe(false);
		expect(hookConfig.features.continuationCommands).toBe(false);
		expect(hookConfig.features.externalScout).toBe(false);
		expect(hookConfig.features.contextScout).toBe(false);
		expect(hookConfig.features.tmuxOrchestration).toBe(false);

		const plugin = await WorkspacePlugin({
			directory: root,
			client: createMockClient(),
		} as never);

		const continuationContinue = plugin.tool
			?.continuation_continue as unknown as ContinuationContinueTool;

		const continuationDisabled = await continuationContinue.execute(
			{},
			{ sessionID: "rollback-session" },
		);
		expect(continuationDisabled).toContain("continuation_continue is disabled");
	});
});
