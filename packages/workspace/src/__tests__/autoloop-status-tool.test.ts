import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { WorkspacePlugin } from "../index";

let tempRoots: string[] = [];

type ContinuationContinueTool = {
	execute: (
		args: { session_id?: string; idempotency_key?: string },
		toolCtx: { sessionID?: string },
	) => Promise<string>;
};

type AutoloopStatusTool = {
	execute: (
		args: { slug: string; session_id?: string },
		toolCtx: { sessionID?: string },
	) => Promise<string>;
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

async function createHarness(input?: {
	continuationCommands?: boolean;
}): Promise<{
	root: string;
	continuationContinue: ContinuationContinueTool;
	autoloopStatus: AutoloopStatusTool;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-autoloop-status-test-"));
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
					continuationCommands: input?.continuationCommands ?? true,
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

	const continuationContinue = plugin.tool?.continuation_continue as unknown as
		| ContinuationContinueTool
		| undefined;
	const autoloopStatus = plugin.tool?.autoloop_status as unknown as
		| AutoloopStatusTool
		| undefined;
	if (!continuationContinue) {
		throw new Error("continuation_continue tool is missing");
	}
	if (!autoloopStatus) {
		throw new Error("autoloop_status tool is missing");
	}

	return {
		root,
		continuationContinue,
		autoloopStatus,
	};
}

describe("autoloop_status tool", () => {
	test("combines paused state with continuation mode without changing lifecycle source", async () => {
		const harness = await createHarness();
		const autoloopDir = join(
			harness.root,
			".opencode",
			"workspace",
			"autoloop",
			"agent-harness",
		);
		await mkdir(autoloopDir, { recursive: true });
		await Bun.write(
			join(autoloopDir, "state.jsonl"),
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
					slug: "agent-harness",
					max_iterations: 50,
				}),
				JSON.stringify({
					type: "iteration",
					iteration: 15,
					timestamp: "2026-03-19T00:10:00Z",
					action: "Added a status helper",
					status: "passed",
					outcome: "keep",
					next_step: "Keep iterating",
				}),
			].join("\n"),
		);
		await Bun.write(join(autoloopDir, ".paused"), "");

		await harness.continuationContinue.execute(
			{ idempotency_key: "autoloop-status-running" },
			{ sessionID: "session-autoloop" },
		);

		const raw = await harness.autoloopStatus.execute(
			{ slug: "agent-harness" },
			{ sessionID: "session-autoloop" },
		);
		const snapshot = JSON.parse(raw) as Record<string, unknown>;

		expect(snapshot.lifecycle_source).toBe("dedicated-plan");
		expect(snapshot.paused).toBe(true);
		expect(snapshot.continuation_mode).toBe("running");
		expect(snapshot.effective_mode).toBe("paused");
		expect(snapshot.latest_iteration).toBe(15);
		expect(snapshot.max_iterations).toBe(50);
		expect(snapshot.next_step).toBe("Keep iterating");
		expect(snapshot.parse_issues).toEqual([]);
	});

	test("defaults continuation mode to running and reports parse issues", async () => {
		const harness = await createHarness({ continuationCommands: false });
		const autoloopDir = join(
			harness.root,
			".opencode",
			"workspace",
			"autoloop",
			"agent-harness",
		);
		await mkdir(autoloopDir, { recursive: true });
		await Bun.write(
			join(autoloopDir, "state.jsonl"),
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
					next_step: "Inspect the next candidate",
				}),
				"{not-json}",
			].join("\n"),
		);

		const raw = await harness.autoloopStatus.execute(
			{ slug: "agent-harness" },
			{},
		);
		const snapshot = JSON.parse(raw) as {
			continuation_mode: string;
			effective_mode: string;
			next_step: string;
			parse_issues: Array<{ line: number; reason: string; raw: string }>;
		};

		expect(snapshot.continuation_mode).toBe("running");
		expect(snapshot.effective_mode).toBe("running");
		expect(snapshot.next_step).toBe("Inspect the next candidate");
		expect(snapshot.parse_issues).toEqual([
			{ line: 2, reason: "invalid json", raw: "{not-json}" },
		]);
	});

	test("rejects blank slugs", async () => {
		const harness = await createHarness();

		await expect(
			harness.autoloopStatus.execute({ slug: "   " }, {}),
		).resolves.toBe("❌ autoloop_status requires a non-empty slug.");
	});

	test("reports missing autoloop state files", async () => {
		const harness = await createHarness();

		await expect(
			harness.autoloopStatus.execute({ slug: "missing-slug" }, {}),
		).resolves.toContain("Autoloop state file not found");
	});
});
