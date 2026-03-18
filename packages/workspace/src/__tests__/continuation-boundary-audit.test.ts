import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { WorkspacePlugin } from "../index";

let tempRoots: string[] = [];

type AskInput = {
	permission: string;
	patterns: string[];
	always: string[];
	metadata: Record<string, unknown>;
};

type ContinuationContinueTool = {
	execute: (
		args: { session_id?: string; idempotency_key?: string },
		toolCtx: { sessionID?: string; ask?: (input: AskInput) => Promise<void> },
	) => Promise<string>;
};

type ContinuationHandoffTool = {
	execute: (
		args: {
			to: string;
			summary: string;
			session_id?: string;
			idempotency_key?: string;
		},
		toolCtx: { sessionID?: string; ask?: (input: AskInput) => Promise<void> },
	) => Promise<string>;
};

type ContinuationStopTool = {
	execute: (
		args: { reason?: string; session_id?: string; idempotency_key?: string },
		toolCtx: { sessionID?: string; ask?: (input: AskInput) => Promise<void> },
	) => Promise<string>;
};

type BoundaryPolicyStatusTool = {
	execute: (
		args: { include_audit_summary?: boolean },
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

async function createHarness(input?: { boundaryPolicyV2?: boolean }): Promise<{
	root: string;
	continuationContinue: ContinuationContinueTool;
	continuationHandoff: ContinuationHandoffTool;
	continuationStop: ContinuationStopTool;
	boundaryPolicyStatus: BoundaryPolicyStatusTool;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-continuation-boundary-test-"));
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
					boundaryPolicyV2: input?.boundaryPolicyV2 ?? true,
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
	const continuationHandoff = plugin.tool?.continuation_handoff as unknown as
		| ContinuationHandoffTool
		| undefined;
	const continuationStop = plugin.tool?.continuation_stop as unknown as
		| ContinuationStopTool
		| undefined;
	const boundaryPolicyStatus = plugin.tool?.boundary_policy_status as unknown as
		| BoundaryPolicyStatusTool
		| undefined;
	if (!continuationContinue) {
		throw new Error("continuation_continue tool is missing");
	}
	if (!continuationHandoff) {
		throw new Error("continuation_handoff tool is missing");
	}
	if (!continuationStop) {
		throw new Error("continuation_stop tool is missing");
	}
	if (!boundaryPolicyStatus) {
		throw new Error("boundary_policy_status tool is missing");
	}

	return {
		root,
		continuationContinue,
		continuationHandoff,
		continuationStop,
		boundaryPolicyStatus,
	};
}

describe("continuation boundary audit", () => {
	test("enforces idempotency when boundaryPolicyV2 is enabled", async () => {
		const harness = await createHarness();

		const blocked = await harness.continuationContinue.execute(
			{},
			{ sessionID: "session-boundary" },
		);
		expect(blocked).toContain("requires idempotency_key");

		const approved = await harness.continuationContinue.execute(
			{ idempotency_key: "key-1" },
			{ sessionID: "session-boundary" },
		);
		expect(approved).toContain('"mode": "running"');
	});

	test("does not block continuation transitions when boundaryPolicyV2 is disabled", async () => {
		const harness = await createHarness({ boundaryPolicyV2: false });

		const continueResult = await harness.continuationContinue.execute(
			{},
			{ sessionID: "session-no-boundary" },
		);
		const handoffResult = await harness.continuationHandoff.execute(
			{ to: "builder", summary: "handoff summary" },
			{ sessionID: "session-no-boundary" },
		);
		const stopResult = await harness.continuationStop.execute(
			{ reason: "done" },
			{ sessionID: "session-no-boundary" },
		);

		expect(continueResult).toContain('"mode": "running"');
		expect(handoffResult).toContain('"mode": "handoff"');
		expect(stopResult).toContain('"mode": "stopped"');
	});

	test("reports boundary diagnostics and gated-path inventory", async () => {
		const harness = await createHarness();

		await harness.continuationContinue.execute(
			{},
			{ sessionID: "session-diagnostics" },
		);

		const payload = await harness.boundaryPolicyStatus.execute(
			{},
			{ sessionID: "session-diagnostics" },
		);
		const parsed = JSON.parse(payload) as {
			feature_flags?: { boundaryPolicyV2?: boolean };
			contracts?: {
				orchestrator_agents?: string[];
				implementer_agents?: string[];
			};
			gated_paths?: {
				continuation_idempotency_required_when_boundary_v2?: string[];
			};
		};

		expect(parsed.feature_flags?.boundaryPolicyV2).toBe(true);
		expect(parsed.contracts?.orchestrator_agents).toContain("build");
		expect(parsed.contracts?.implementer_agents).toContain("coder");
		expect(
			parsed.gated_paths?.continuation_idempotency_required_when_boundary_v2,
		).toContain("continuation_continue");
	});
});
