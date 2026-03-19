import { afterEach, describe, expect, test } from "bun:test";
import { parseAutoloopStateFile } from "../autoloop/state";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { WorkspacePlugin } from "../index";

let tempRoots: string[] = [];

type AutoloopCheckpointTool = {
	execute: (args: {
		slug: string;
		action: string;
		files_changed?: string[];
		verification?: string[];
		status?: string;
		outcome?: "keep" | "discard" | "blocked" | "done";
		next_step: string;
		timestamp?: string;
	}) => Promise<string>;
};

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
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

async function createHarness(): Promise<{
	root: string;
	autoloopCheckpoint: AutoloopCheckpointTool;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-autoloop-checkpoint-test-"));
	tempRoots.push(root);

	const opencodeDir = join(root, ".opencode");
	const workspaceDir = join(opencodeDir, "workspace");
	await mkdir(opencodeDir, { recursive: true });
	await mkdir(workspaceDir, { recursive: true });

	await Bun.write(
		join(opencodeDir, "workspace.json"),
		JSON.stringify(
			{
				features: {
					continuationCommands: true,
					boundaryPolicyV2: true,
				},
			},
			null,
			2,
		),
	);

	const plugin = await WorkspacePlugin({
		directory: root,
		client: createMockClient(),
	} as never);

	const autoloopCheckpoint = plugin.tool?.autoloop_checkpoint as unknown as
		| AutoloopCheckpointTool
		| undefined;
	if (!autoloopCheckpoint) {
		throw new Error("autoloop_checkpoint tool is missing");
	}

	return {
		root,
		autoloopCheckpoint,
	};
}

describe("autoloop_checkpoint tool", () => {
	test("assigns monotonic iterations under concurrent checkpoint writes", async () => {
		const harness = await createHarness();
		const autoloopDir = join(
			harness.root,
			".opencode",
			"workspace",
			"autoloop",
			"agent-harness",
		);
		const statePath = join(autoloopDir, "state.jsonl");
		await mkdir(autoloopDir, { recursive: true });
		await Bun.write(
			statePath,
			JSON.stringify({
				type: "config",
				timestamp: "2026-03-19T00:00:00Z",
				goal: "Improve the harness",
				slug: "agent-harness",
				max_iterations: 50,
			}),
		);

		const [firstRaw, secondRaw] = await Promise.all([
			harness.autoloopCheckpoint.execute({
				slug: "agent-harness",
				action: "First concurrent writer",
				files_changed: ["a.ts"],
				verification: ["bun test a"],
				next_step: "Keep iterating",
				timestamp: "2026-03-19T00:01:00Z",
			}),
			harness.autoloopCheckpoint.execute({
				slug: "agent-harness",
				action: "Second concurrent writer",
				files_changed: ["b.ts"],
				verification: ["bun test b"],
				next_step: "Still iterating",
				timestamp: "2026-03-19T00:01:01Z",
			}),
		]);

		const first = JSON.parse(firstRaw) as { entry: { iteration: number } };
		const second = JSON.parse(secondRaw) as { entry: { iteration: number } };
		expect(
			[first.entry.iteration, second.entry.iteration].sort((a, b) => a - b),
		).toEqual([1, 2]);

		const parsed = parseAutoloopStateFile(await Bun.file(statePath).text());
		expect(
			parsed.entries
				.filter((entry) => entry.type === "iteration")
				.map((entry) => entry.iteration)
				.sort((a, b) => a - b),
		).toEqual([1, 2]);
		expect(parsed.issues).toEqual([]);
	});

	test("rejects blank slugs and missing state files", async () => {
		const harness = await createHarness();

		await expect(
			harness.autoloopCheckpoint.execute({
				slug: "   ",
				action: "noop",
				next_step: "noop",
			}),
		).resolves.toBe("❌ autoloop_checkpoint requires a non-empty slug.");

		await expect(
			harness.autoloopCheckpoint.execute({
				slug: "missing-slug",
				action: "noop",
				next_step: "noop",
			}),
		).resolves.toContain("Autoloop state file not found");
	});

	test("refuses to append when state.jsonl has parse issues", async () => {
		const harness = await createHarness();
		const autoloopDir = join(
			harness.root,
			".opencode",
			"workspace",
			"autoloop",
			"agent-harness",
		);
		const statePath = join(autoloopDir, "state.jsonl");
		await mkdir(autoloopDir, { recursive: true });
		await Bun.write(
			statePath,
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
				}),
				"{not-json}",
			].join("\n"),
		);

		await expect(
			harness.autoloopCheckpoint.execute({
				slug: "agent-harness",
				action: "checkpoint",
				next_step: "repair first",
			}),
		).resolves.toContain("state.jsonl has parse issues at lines: 2");
	});
});
