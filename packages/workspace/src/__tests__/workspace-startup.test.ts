import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { WorkspacePlugin } from "../index";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

function createMockClient() {
	return {
		session: {
			get: async (input: { path: { id: string } }) => ({
				data: { id: input.path.id },
			}),
		},
	};
}

describe("workspace startup", () => {
	test("defers project-id git shelling until first legacy lookup", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-workspace-startup-"));
		tempRoots.push(root);

		const spawnSpy = spyOn(Bun, "spawn");
		const countProjectIdShellCalls = () =>
			spawnSpy.mock.calls.filter((call) => {
				const [command] = call as [unknown, ...unknown[]];
				return (
					Array.isArray(command) &&
					command[0] === "git" &&
					command[1] === "rev-list" &&
					command[2] === "--max-parents=0" &&
					command[3] === "HEAD"
				);
			}).length;
		try {
			const plugin = await WorkspacePlugin({
				directory: root,
				client: createMockClient(),
			} as never);

			expect(countProjectIdShellCalls()).toBe(0);

			const planReadTool = plugin.tool?.plan_read as
				| {
						execute: (
							args: { reason: string },
							toolCtx: { sessionID: string },
						) => Promise<string>;
				  }
				| undefined;
			expect(planReadTool).toBeDefined();
			if (!planReadTool) {
				throw new Error("plan_read tool is missing");
			}

			const firstResult = await planReadTool.execute(
				{ reason: "startup test" },
				{ sessionID: "session-1" },
			);
			expect(firstResult).toContain("No plan found");

			expect(countProjectIdShellCalls()).toBe(1);

			await planReadTool.execute(
				{ reason: "startup test repeat" },
				{ sessionID: "session-1" },
			);

			expect(countProjectIdShellCalls()).toBe(1);
		} finally {
			spawnSpy.mockRestore();
		}
	});
});
