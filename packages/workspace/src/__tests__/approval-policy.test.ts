import { describe, expect, test } from "bun:test";
import {
	getApprovalRiskTier,
	resolveApprovalPolicy,
	shouldEnforceApproval,
} from "../approval/policy";

describe("approval policy", () => {
	test("uses safe defaults with policy disabled", () => {
		const policy = resolveApprovalPolicy();

		expect(policy.mode).toBe("off");
		expect(policy.tools).toEqual([
			"plan_archive",
			"delegation_cancel",
			"worktree_delete",
		]);
		expect(policy.nonInteractive).toBe("fail-closed");
		expect(policy.ttlMs).toBe(300000);
	});

	test("selected mode enforces only configured tools", () => {
		const policy = resolveApprovalPolicy({
			mode: "selected",
			tools: ["plan_archive"],
		});

		expect(
			shouldEnforceApproval({
				toolName: "plan_archive",
				featureEnabled: true,
				policy,
			}),
		).toBe(true);

		expect(
			shouldEnforceApproval({
				toolName: "delegation_cancel",
				featureEnabled: true,
				policy,
			}),
		).toBe(false);
	});

	test("all_mutating mode covers mutable workflow tools", () => {
		const policy = resolveApprovalPolicy({ mode: "all_mutating" });

		expect(
			shouldEnforceApproval({
				toolName: "worktree_create",
				featureEnabled: true,
				policy,
			}),
		).toBe(true);

		expect(
			shouldEnforceApproval({
				toolName: "delegation_cancel",
				featureEnabled: true,
				policy,
			}),
		).toBe(true);

		expect(
			shouldEnforceApproval({
				toolName: "plan_read",
				featureEnabled: true,
				policy,
			}),
		).toBe(false);
	});

	test("supports explicit exemptions", () => {
		const policy = resolveApprovalPolicy({
			mode: "all_mutating",
			exemptTools: ["worktree_delete"],
		});

		expect(
			shouldEnforceApproval({
				toolName: "worktree_delete",
				featureEnabled: true,
				policy,
			}),
		).toBe(false);
	});

	test("respects feature-level disable", () => {
		const policy = resolveApprovalPolicy({ mode: "all_mutating" });

		expect(
			shouldEnforceApproval({
				toolName: "plan_archive",
				featureEnabled: false,
				policy,
			}),
		).toBe(false);
	});

	test("normalizes ttl and reports risk tiers", () => {
		const policy = resolveApprovalPolicy({ ttlMs: 0 });
		expect(policy.ttlMs).toBe(0);

		expect(getApprovalRiskTier("worktree_delete")).toBe("high");
		expect(getApprovalRiskTier("plan_unarchive")).toBe("medium");
		expect(getApprovalRiskTier("plan_read")).toBeNull();
	});
});
