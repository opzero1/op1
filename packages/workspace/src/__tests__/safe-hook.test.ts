import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat.js";
import { loadHookConfig, resolveHookConfig } from "../hooks/safe-hook.js";

const originalHome = Bun.env.HOME;
const originalNotifications = Bun.env.OP7_WORKSPACE_NOTIFICATIONS;
const originalDesktopNotifications =
	Bun.env.OP7_WORKSPACE_NOTIFICATIONS_DESKTOP;
const originalVerificationAutopilot = Bun.env.OP7_VERIFICATION_AUTOPILOT;
const originalTaskReminderThreshold =
	Bun.env.OP7_WORKSPACE_TASK_REMINDER_THRESHOLD;

let tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];

	if (originalHome === undefined) {
		delete Bun.env.HOME;
	} else {
		Bun.env.HOME = originalHome;
	}

	if (originalNotifications === undefined) {
		delete Bun.env.OP7_WORKSPACE_NOTIFICATIONS;
	} else {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = originalNotifications;
	}

	if (originalDesktopNotifications === undefined) {
		delete Bun.env.OP7_WORKSPACE_NOTIFICATIONS_DESKTOP;
	} else {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_DESKTOP = originalDesktopNotifications;
	}

	if (originalVerificationAutopilot === undefined) {
		delete Bun.env.OP7_VERIFICATION_AUTOPILOT;
	} else {
		Bun.env.OP7_VERIFICATION_AUTOPILOT = originalVerificationAutopilot;
	}

	if (originalTaskReminderThreshold === undefined) {
		delete Bun.env.OP7_WORKSPACE_TASK_REMINDER_THRESHOLD;
	} else {
		Bun.env.OP7_WORKSPACE_TASK_REMINDER_THRESHOLD =
			originalTaskReminderThreshold;
	}
});

describe("safe-hook config", () => {
	test("resolves default workspace config contract", () => {
		const config = resolveHookConfig();

		expect(config.features.momentum).toBe(true);
		expect(config.features.notifications).toBe(true);
		expect(config.features.hashAnchoredEdit).toBe(true);
		expect(config.features.taskGraph).toBe(true);
		expect(config.features.continuationCommands).toBe(true);
		expect(config.features.tmuxOrchestration).toBe(true);
		expect(config.features.approvalGate).toBe(false);
		expect(config.features.boundaryPolicyV2).toBe(true);
		expect(config.features.claudeCompatibility).toBe(true);
		expect(config.features.mcpOAuthHelper).toBe(true);
		expect(config.approval.mode).toBe("off");
		expect(config.approval.tools).toEqual([
			"plan_archive",
			"background_cancel",
			"worktree_delete",
		]);
		expect(config.approval.nonInteractive).toBe("fail-closed");
		expect(config.thresholds.taskReminderThreshold).toBe(20);
		expect(config.thresholds.contextLimit).toBe(200000);
		expect(config.notifications.enabled).toBe(true);
		expect(config.notifications.desktop).toBe(true);
		expect(config.notifications.privacy).toBe("strict");
		expect(config.skillPointer.mode).toBe("fallback");
	});

	test("parses skillPointer mode from workspace config", async () => {
		const projectRoot = await mkdtemp(
			join(tmpdir(), "op1-safe-hook-skill-pointer-"),
		);
		tempRoots.push(projectRoot);

		const projectConfigDir = join(projectRoot, ".opencode");
		await mkdir(projectConfigDir, { recursive: true });
		await Bun.write(
			join(projectConfigDir, "workspace.json"),
			JSON.stringify(
				{
					skillPointer: {
						mode: "exclusive",
					},
				},
				null,
				2,
			),
		);

		const config = await loadHookConfig(projectRoot);
		expect(config.skillPointer.mode).toBe("exclusive");
	});

	test("adds disabled hooks when related features are off", () => {
		const config = resolveHookConfig({
			features: {
				momentum: false,
				taskReminder: false,
				externalScout: false,
				contextScout: false,
			},
		});

		expect(config.disabledHooks).toContain("momentum");
		expect(config.disabledHooks).toContain("taskReminder");
		expect(config.disabledHooks).toContain("tool.execute.after.contextScout");
	});

	test("maps externalScout to contextScout behavior", () => {
		const config = resolveHookConfig({
			features: {
				externalScout: true,
			},
		});

		expect(config.features.externalScout).toBe(true);
		expect(config.features.contextScout).toBe(true);
		expect(config.disabledHooks).not.toContain(
			"tool.execute.after.contextScout",
		);
	});

	test("wires feature verificationAutopilot to verification config by default", () => {
		delete Bun.env.OP7_VERIFICATION_AUTOPILOT;
		const config = resolveHookConfig({
			features: {
				verificationAutopilot: false,
			},
		});

		expect(config.features.verificationAutopilot).toBe(false);
		expect(config.verification.autopilot).toBe(false);
	});

	test("allows explicit verification.autopilot to override feature alias", () => {
		const config = resolveHookConfig({
			features: {
				verificationAutopilot: false,
			},
			verification: {
				autopilot: true,
			},
		});

		expect(config.verification.autopilot).toBe(true);
		expect(config.features.verificationAutopilot).toBe(true);
	});

	test("enables boundary hardening bundle when boundaryPolicyV2 is on", () => {
		const config = resolveHookConfig({
			features: {
				boundaryPolicyV2: true,
				approvalGate: false,
				hashAnchoredEdit: false,
				autonomyPolicy: false,
			},
		});

		expect(config.features.boundaryPolicyV2).toBe(true);
		expect(config.features.approvalGate).toBe(false);
		expect(config.features.hashAnchoredEdit).toBe(true);
		expect(config.features.autonomyPolicy).toBe(true);
	});

	test("loads project config over global config", async () => {
		const homeRoot = await mkdtemp(join(tmpdir(), "op1-safe-hook-home-"));
		tempRoots.push(homeRoot);
		Bun.env.HOME = homeRoot;

		const globalConfigDir = join(homeRoot, ".config", "opencode");
		await mkdir(globalConfigDir, { recursive: true });
		await Bun.write(
			join(globalConfigDir, "workspace.json"),
			JSON.stringify(
				{
					features: { notifications: true },
					thresholds: { taskReminderThreshold: 11 },
				},
				null,
				2,
			),
		);

		const projectRoot = await mkdtemp(join(tmpdir(), "op1-safe-hook-project-"));
		tempRoots.push(projectRoot);

		const projectConfigDir = join(projectRoot, ".opencode");
		await mkdir(projectConfigDir, { recursive: true });
		await Bun.write(
			join(projectConfigDir, "workspace.json"),
			JSON.stringify(
				{
					features: { notifications: false },
					thresholds: { taskReminderThreshold: 3 },
				},
				null,
				2,
			),
		);

		const config = await loadHookConfig(projectRoot);

		expect(config.features.notifications).toBe(false);
		expect(config.thresholds.taskReminderThreshold).toBe(3);
		expect(config.features.momentum).toBe(true);
	});

	test("applies environment overrides", () => {
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS = "true";
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_DESKTOP = "false";
		Bun.env.OP7_WORKSPACE_TASK_REMINDER_THRESHOLD = "4";

		const config = resolveHookConfig({
			features: { notifications: false },
			thresholds: { taskReminderThreshold: 20 },
		});

		expect(config.features.notifications).toBe(true);
		expect(config.notifications.enabled).toBe(true);
		expect(config.notifications.desktop).toBe(false);
		expect(config.thresholds.taskReminderThreshold).toBe(4);
	});

	test("parses approval policy from workspace config", async () => {
		const projectRoot = await mkdtemp(
			join(tmpdir(), "op1-safe-hook-approval-"),
		);
		tempRoots.push(projectRoot);

		const projectConfigDir = join(projectRoot, ".opencode");
		await mkdir(projectConfigDir, { recursive: true });
		await Bun.write(
			join(projectConfigDir, "workspace.json"),
			JSON.stringify(
				{
					features: { approvalGate: true },
					approval: {
						mode: "all_mutating",
						exemptTools: ["worktree_delete"],
						ttlMs: 120000,
						nonInteractive: "fail-closed",
					},
				},
				null,
				2,
			),
		);

		const config = await loadHookConfig(projectRoot);

		expect(config.features.approvalGate).toBe(true);
		expect(config.approval.mode).toBe("all_mutating");
		expect(config.approval.exemptTools).toEqual(["worktree_delete"]);
		expect(config.approval.ttlMs).toBe(120000);
		expect(config.approval.nonInteractive).toBe("fail-closed");
	});
});
