import { describe, expect, test } from "bun:test";
import { enforceMcpPointerAvailability } from "../interop/mcp-pointer-enforcement";

describe("mcp pointer enforcement", () => {
	test("fails closed when required MCP is unavailable", () => {
		const result = enforceMcpPointerAvailability([
			{ serverId: "context7", requirement: "required", available: false },
			{ serverId: "figma", requirement: "optional", available: false },
		]);

		expect(result.ok).toBe(false);
		expect(result.blockingRequired).toEqual(["context7"]);
		expect(result.degradedOptional).toEqual(["figma"]);
	});

	test("passes when all required MCPs are available", () => {
		const result = enforceMcpPointerAvailability([
			{ serverId: "context7", requirement: "required", available: true },
			{ serverId: "figma", requirement: "optional", available: false },
		]);

		expect(result.ok).toBe(true);
		expect(result.blockingRequired).toHaveLength(0);
		expect(result.degradedOptional).toEqual(["figma"]);
	});
});
