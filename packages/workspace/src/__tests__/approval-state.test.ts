import { afterEach, describe, expect, test } from "bun:test";
import { createApprovalStateManager } from "../approval/state";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";

let tempRoots: string[] = [];

async function createTempWorkspace(): Promise<{
	root: string;
	workspaceDir: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-workspace-approval-test-"));
	const workspaceDir = join(root, ".opencode", "workspace");
	await mkdir(workspaceDir, { recursive: true });
	return { root, workspaceDir };
}

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
});

describe("approval state manager", () => {
	test("persists active grant and supports replay-safe request IDs", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createApprovalStateManager(env.workspaceDir);
		const first = await manager.approveTool({
			sessionID: "root-approval",
			tool: "plan_archive",
			ttlMs: 60000,
			requestID: "req-1",
		});

		expect(first).toBeDefined();
		expect(first?.tool).toBe("plan_archive");

		const replay = await manager.approveTool({
			sessionID: "root-approval",
			tool: "plan_archive",
			ttlMs: 60000,
			requestID: "req-1",
		});
		expect(replay?.grant_id).toBe(first?.grant_id);

		const active = await manager.getActiveGrant(
			"root-approval",
			"plan_archive",
		);
		expect(active?.grant_id).toBe(first?.grant_id);
	});

	test("expires grant based on ttl", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createApprovalStateManager(env.workspaceDir);
		const grant = await manager.approveTool({
			sessionID: "root-expiry",
			tool: "background_cancel",
			ttlMs: 1,
		});
		expect(grant).toBeDefined();

		await new Promise((resolve) => setTimeout(resolve, 5));

		const active = await manager.getActiveGrant(
			"root-expiry",
			"background_cancel",
		);
		expect(active).toBeNull();
	});

	test("records auditable decision trail", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createApprovalStateManager(env.workspaceDir);
		await manager.recordAudit({
			session_id: "root-audit",
			tool: "worktree_delete",
			outcome: "denied",
			reason: "prompt_denied",
			detail: "User rejected approval prompt",
			metadata: {
				requested_by: "test",
			},
		});

		const reloaded = createApprovalStateManager(env.workspaceDir);
		const store = await reloaded.readStore();
		expect(store.audit.length).toBe(1);
		expect(store.audit[0]?.tool).toBe("worktree_delete");
		expect(store.audit[0]?.outcome).toBe("denied");
		expect(store.audit[0]?.reason).toBe("prompt_denied");
	});

	test("persists policy boundary audit reasons", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createApprovalStateManager(env.workspaceDir);
		await manager.recordAudit({
			session_id: "root-policy",
			tool: "continuation_continue",
			outcome: "blocked",
			reason: "policy_idempotency_required",
			detail: "Missing idempotency key while boundaryPolicyV2 is enabled",
		});

		await manager.recordAudit({
			session_id: "root-policy",
			tool: "continuation_continue",
			outcome: "approved",
			reason: "policy_transition_applied",
			metadata: {
				mode: "running",
			},
		});

		const store = await createApprovalStateManager(
			env.workspaceDir,
		).readStore();
		const reasons = store.audit.map((entry) => entry.reason);
		expect(reasons).toContain("policy_idempotency_required");
		expect(reasons).toContain("policy_transition_applied");
	});

	test("recovers malformed JSON with trailing commas", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const statePath = join(env.workspaceDir, "approval-gate.json");
		await Bun.write(
			statePath,
			`{
			  "version": 1,
			  "sessions": {
			    "root-recovery": {
			      "updated_at": "2026-03-01T00:00:00.000Z",
			      "grants": {
			        "plan_archive": {
			          "tool": "plan_archive",
			          "grant_id": "g-1",
			          "approved_at": "2026-03-01T00:00:00.000Z",
			          "expires_at": "2999-01-01T00:00:00.000Z",
			        }
			      },
			      "replayed_request_ids": {}
			    }
			  },
			  "audit": [],
			}`,
		);

		const manager = createApprovalStateManager(env.workspaceDir);
		const active = await manager.getActiveGrant(
			"root-recovery",
			"plan_archive",
		);
		expect(active?.grant_id).toBe("g-1");
	});
});
