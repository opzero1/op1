import { describe, expect, test } from "bun:test";
import { McpPointerCapabilityCache } from "../interop/mcp-pointer-capability-cache";

describe("mcp pointer capability cache", () => {
	test("returns fresh then stale based on refresh window", () => {
		const cache = new McpPointerCapabilityCache<{ tools: string[] }>();
		cache.upsert({
			serverId: "context7",
			capability: { tools: ["context7_query-docs"] },
			nowMs: 1000,
			softTtlMs: 100,
			hardTtlMs: 500,
			jitterRatio: 0,
		});

		expect(cache.read("context7", 1050).state).toBe("fresh");
		expect(cache.read("context7", 1200).state).toBe("stale");
	});

	test("invalidates on list_changed and configured errors", () => {
		const cache = new McpPointerCapabilityCache<{ tools: string[] }>();
		cache.upsert({
			serverId: "linear",
			capability: { tools: ["linear_list_issues"] },
			nowMs: 1000,
		});

		cache.handleListChanged("linear");
		expect(cache.read("linear", 1001).state).toBe("missing");

		cache.upsert({
			serverId: "linear",
			capability: { tools: ["linear_list_issues"] },
			nowMs: 1000,
		});
		expect(
			cache.invalidateIfNeeded({
				serverId: "linear",
				errorCode: "auth_expired",
			}),
		).toBe(true);
		expect(cache.read("linear", 1002).state).toBe("missing");
	});
});
