import { afterEach, describe, expect, test } from "bun:test";

import { handleVerification } from "../hooks/verification";

const originalAutopilot = Bun.env.OP7_VERIFICATION_AUTOPILOT;
const originalThrottle = Bun.env.OP7_VERIFICATION_AUTOPILOT_THROTTLE_MS;

afterEach(() => {
	if (originalAutopilot === undefined) {
		delete Bun.env.OP7_VERIFICATION_AUTOPILOT;
	} else {
		Bun.env.OP7_VERIFICATION_AUTOPILOT = originalAutopilot;
	}

	if (originalThrottle === undefined) {
		delete Bun.env.OP7_VERIFICATION_AUTOPILOT_THROTTLE_MS;
	} else {
		Bun.env.OP7_VERIFICATION_AUTOPILOT_THROTTLE_MS = originalThrottle;
	}
});

describe("verification autopilot", () => {
	test("injects verification reminder for implementer task", async () => {
		const output = { output: "Task done" };

		await handleVerification(
			{
				tool: "task",
				sessionID: "session-a",
				callID: "call-a",
				args: { subagent_type: "coder" },
			},
			output,
			"/tmp",
		);

		expect(output.output).toContain("MANDATORY VERIFICATION PROTOCOL");
		expect(output.output).toContain("**READ**");
		expect(output.output).toContain("**AUTOMATED CHECKS**");
		expect(output.output).toContain("**MANUAL QA**");
		expect(output.output).toContain("**GATE DECISION**");

		const readIndex = output.output.indexOf("**READ**");
		const checksIndex = output.output.indexOf("**AUTOMATED CHECKS**");
		const manualQaIndex = output.output.indexOf("**MANUAL QA**");
		const decisionIndex = output.output.indexOf("**GATE DECISION**");

		expect(readIndex).toBeGreaterThan(-1);
		expect(checksIndex).toBeGreaterThan(readIndex);
		expect(manualQaIndex).toBeGreaterThan(checksIndex);
		expect(decisionIndex).toBeGreaterThan(manualQaIndex);
	});

	test("skips duplicate reminder for same session/call", async () => {
		const first = { output: "first" };
		await handleVerification(
			{
				tool: "task",
				sessionID: "session-b",
				callID: "call-b",
				args: { subagent_type: "coder" },
			},
			first,
			"/tmp",
		);

		const second = { output: "second" };
		await handleVerification(
			{
				tool: "task",
				sessionID: "session-b",
				callID: "call-b",
				args: { subagent_type: "coder" },
			},
			second,
			"/tmp",
		);

		expect(first.output).toContain("MANDATORY VERIFICATION PROTOCOL");
		expect(second.output).toBe("second");
	});

	test("respects autopilot disable override", async () => {
		Bun.env.OP7_VERIFICATION_AUTOPILOT = "off";

		const output = { output: "done" };
		await handleVerification(
			{
				tool: "task",
				sessionID: "session-c",
				callID: "call-c",
				args: { subagent_type: "coder" },
			},
			output,
			"/tmp",
		);

		expect(output.output).toBe("done");
	});

	test("allows repeated reminders when throttle is zero", async () => {
		Bun.env.OP7_VERIFICATION_AUTOPILOT_THROTTLE_MS = "0";

		const first = { output: "first" };
		await handleVerification(
			{
				tool: "task",
				sessionID: "session-d",
				callID: "call-d-1",
				args: { subagent_type: "coder" },
			},
			first,
			"/tmp",
		);

		const second = { output: "second" };
		await handleVerification(
			{
				tool: "task",
				sessionID: "session-d",
				callID: "call-d-2",
				args: { subagent_type: "coder" },
			},
			second,
			"/tmp",
		);

		expect(first.output).toContain("MANDATORY VERIFICATION PROTOCOL");
		expect(second.output).toContain("MANDATORY VERIFICATION PROTOCOL");
	});
});
