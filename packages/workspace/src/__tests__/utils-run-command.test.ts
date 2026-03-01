import { describe, expect, test } from "bun:test";
import { runCommand } from "../utils";

describe("runCommand", () => {
	test("returns stdout for successful commands", async () => {
		const output = await runCommand(
			["bun", "-e", "process.stdout.write('ok')"],
			process.cwd(),
		);

		expect(output).toBe("ok");
	});

	test("throws when command exits non-zero", async () => {
		await expect(
			runCommand(
				["bun", "-e", "console.error('boom'); process.exit(2)"],
				process.cwd(),
			),
		).rejects.toThrow("boom");
	});
});
