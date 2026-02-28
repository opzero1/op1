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

type PlanArchiveTool = {
	execute: (
		args: { identifier: string },
		toolCtx: { sessionID?: string; ask?: (input: AskInput) => Promise<void> },
	) => Promise<string>;
};

interface ApprovalAuditEntry {
	outcome: "approved" | "denied" | "blocked";
	reason:
		| "cached_grant"
		| "prompt_approved"
		| "prompt_denied"
		| "prompt_unavailable"
		| "non_interactive_blocked";
	detail?: string;
}

interface ApprovalStoreSnapshot {
	audit?: ApprovalAuditEntry[];
	sessions?: Record<
		string,
		{
			grants?: Record<string, { grant_id: string }>;
		}
	>;
}

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
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
				const hasEntry = Object.hasOwn(sessionParents, input.path.id);
				if (hasEntry) {
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

async function createHarness(input?: {
	nonInteractive?: "fail-closed";
	ttlMs?: number;
	sessionParents?: Record<string, string | undefined>;
}): Promise<{ root: string; planArchive: PlanArchiveTool }> {
	const root = await mkdtemp(join(tmpdir(), "op1-approval-gate-runtime-test-"));
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
					approvalGate: true,
				},
				approval: {
					mode: "selected",
					tools: ["plan_archive"],
					ttlMs: input?.ttlMs ?? 300000,
					nonInteractive: input?.nonInteractive ?? "fail-closed",
				},
			},
			null,
			2,
		),
	);

	const plugin = await WorkspacePlugin({
		directory: root,
		client: createMockClient(input?.sessionParents),
	} as never);

	const toolMap = plugin.tool;
	const planArchive = toolMap?.plan_archive as unknown as
		| PlanArchiveTool
		| undefined;
	if (!planArchive) {
		throw new Error("plan_archive tool is missing");
	}

	return {
		root,
		planArchive,
	};
}

async function readApprovalStore(root: string): Promise<ApprovalStoreSnapshot> {
	const statePath = join(root, ".opencode", "workspace", "approval-gate.json");
	const file = Bun.file(statePath);
	if (!(await file.exists())) {
		return {};
	}

	const content = await file.text();
	return JSON.parse(content) as ApprovalStoreSnapshot;
}

describe("approval gate runtime", () => {
	test("blocks in non-interactive sessions when ask is unavailable and fail-closed is enabled", async () => {
		const harness = await createHarness({ nonInteractive: "fail-closed" });

		const result = await harness.planArchive.execute(
			{ identifier: "missing-plan" },
			{ sessionID: "session-fail-closed" },
		);

		expect(result).toContain("approval-gated");
		expect(result).toContain("prompts are unavailable");

		const store = await readApprovalStore(harness.root);
		const latest = store.audit?.[store.audit.length - 1];
		expect(latest?.outcome).toBe("blocked");
		expect(latest?.reason).toBe("prompt_unavailable");
	});

	test("records approval and reuses cached grant across child and root sessions", async () => {
		const harness = await createHarness({
			sessionParents: {
				"child-session": "root-session",
				"root-session": undefined,
			},
		});

		let askCount = 0;
		const firstResult = await harness.planArchive.execute(
			{ identifier: "missing-plan" },
			{
				sessionID: "child-session",
				ask: async () => {
					askCount += 1;
				},
			},
		);
		expect(firstResult).not.toContain("requires approval and was denied");

		const secondResult = await harness.planArchive.execute(
			{ identifier: "missing-plan" },
			{
				sessionID: "root-session",
				ask: async () => {
					askCount += 1;
					throw new Error("ask should not be called after cached grant");
				},
			},
		);
		expect(secondResult).not.toContain("requires approval and was denied");
		expect(askCount).toBe(1);

		const store = await readApprovalStore(harness.root);
		expect(
			store.sessions?.["root-session"]?.grants?.plan_archive?.grant_id,
		).toBeDefined();

		const reasons = (store.audit ?? []).map((entry) => entry.reason);
		expect(reasons).toContain("prompt_approved");
		expect(reasons).toContain("cached_grant");
	});

	test("returns denied result when ask rejects", async () => {
		const harness = await createHarness();

		const result = await harness.planArchive.execute(
			{ identifier: "missing-plan" },
			{
				sessionID: "session-deny",
				ask: async () => {
					throw new Error("approval rejected by test");
				},
			},
		);

		expect(result).toContain("requires approval and was denied or cancelled");

		const store = await readApprovalStore(harness.root);
		const latest = store.audit?.[store.audit.length - 1];
		expect(latest?.outcome).toBe("denied");
		expect(latest?.reason).toBe("prompt_denied");
		expect(latest?.detail).toContain("approval rejected by test");
	});

	test("treats timeout failures as denied approvals", async () => {
		const harness = await createHarness();

		const result = await harness.planArchive.execute(
			{ identifier: "missing-plan" },
			{
				sessionID: "session-timeout",
				ask: async () => {
					throw new Error("Timed out waiting for approval response");
				},
			},
		);

		expect(result).toContain("requires approval and was denied or cancelled");

		const store = await readApprovalStore(harness.root);
		const latest = store.audit?.[store.audit.length - 1];
		expect(latest?.outcome).toBe("denied");
		expect(latest?.reason).toBe("prompt_denied");
		expect(latest?.detail).toContain("Timed out");
	});

	test("blocks non-interactive ask failures", async () => {
		const blockedHarness = await createHarness({
			nonInteractive: "fail-closed",
		});
		const blockedResult = await blockedHarness.planArchive.execute(
			{ identifier: "missing-plan" },
			{
				sessionID: "session-blocked",
				ask: async () => {
					throw new Error("Cannot ask in non-interactive TTY session");
				},
			},
		);
		expect(blockedResult).toContain("blocked in non-interactive sessions");

		const blockedStore = await readApprovalStore(blockedHarness.root);
		const blockedLatest = blockedStore.audit?.[blockedStore.audit.length - 1];
		expect(blockedLatest?.outcome).toBe("blocked");
		expect(blockedLatest?.reason).toBe("non_interactive_blocked");
	});

	test("re-prompts after approval TTL expires", async () => {
		const harness = await createHarness({ ttlMs: 1 });

		let askCount = 0;
		await harness.planArchive.execute(
			{ identifier: "missing-plan" },
			{
				sessionID: "session-ttl",
				ask: async () => {
					askCount += 1;
				},
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 6));

		await harness.planArchive.execute(
			{ identifier: "missing-plan" },
			{
				sessionID: "session-ttl",
				ask: async () => {
					askCount += 1;
				},
			},
		);

		expect(askCount).toBe(2);

		const store = await readApprovalStore(harness.root);
		const approvedPrompts = (store.audit ?? []).filter(
			(entry) => entry.reason === "prompt_approved",
		);
		expect(approvedPrompts.length).toBeGreaterThanOrEqual(2);
	});
});
