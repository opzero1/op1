import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";

import {
	type DoctorReport,
	redactDoctorReport,
	runDoctorDiagnostics,
} from "../doctor";

let tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
});

describe("doctor diagnostics", () => {
	test("produces workspace checks", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-doctor-test-"));
		tempRoots.push(root);

		const workspaceDir = join(root, ".opencode", "workspace");
		const plansDir = join(workspaceDir, "plans");
		const notepadsDir = join(workspaceDir, "notepads");

		await mkdir(plansDir, { recursive: true });
		await mkdir(notepadsDir, { recursive: true });

		const report = await runDoctorDiagnostics({
			directory: root,
			workspaceDir,
			plansDir,
			notepadsDir,
			readActivePlanState: async () => null,
			listPlanRecords: async () => [],
			readPlanDocRegistry: async () => ({ version: 1, plans: {}, docs: {} }),
		});

		expect(report.checks.length).toBeGreaterThan(0);
		expect(
			report.checks.find((check) => check.id === "workspace-dir")?.status,
		).toBe("ok");
		expect(
			report.checks.find((check) => check.id === "active-plan")?.status,
		).toBe("warn");
	});

	test("redacts pii from report content", () => {
		const report: DoctorReport = {
			generated_at: "2026-02-20T00:00:00.000Z",
			status: "warn",
			checks: [
				{
					id: "pii-check",
					status: "warn",
					summary: "Contact dev@example.com with token=abc123",
					remedy: "Rotate api_key=secret-value",
					details: {
						email: "dev@example.com",
						authorization: "Bearer my-secret-token",
						note: "api_key=hello-world",
					},
				},
			],
		};

		const redacted = redactDoctorReport(report);
		const payload = JSON.stringify(redacted);

		expect(payload).not.toContain("dev@example.com");
		expect(payload).not.toContain("abc123");
		expect(payload).not.toContain("secret-value");
		expect(payload).not.toContain("my-secret-token");
		expect(payload).toContain("[REDACTED");
	});
});
