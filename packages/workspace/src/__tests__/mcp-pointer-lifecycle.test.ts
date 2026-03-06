import { describe, expect, test } from "bun:test";
import { McpPointerLifecycleManager } from "../interop/mcp-pointer-lifecycle";

describe("mcp pointer lifecycle manager", () => {
	test("dedupes concurrent starts via singleflight", async () => {
		const manager = new McpPointerLifecycleManager();
		let calls = 0;

		const action = async (_signal: AbortSignal) => {
			calls += 1;
		};

		await Promise.all([
			manager.start("context7", action),
			manager.start("context7", action),
		]);

		expect(calls).toBe(1);
		expect(manager.getSnapshot("context7").state).toBe("ready");
	});

	test("retries failed start and ends degraded when exhausted", async () => {
		const manager = new McpPointerLifecycleManager();
		let attempts = 0;

		await expect(
			manager.start("linear", async (_signal: AbortSignal) => {
				attempts += 1;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(attempts).toBeGreaterThan(1);
		expect(manager.getSnapshot("linear").state).toBe("degraded");
	});

	test("closes after start settles", async () => {
		const manager = new McpPointerLifecycleManager();
		await manager.start("grep_app", async (_signal: AbortSignal) => {});
		await manager.close("grep_app", async (_signal: AbortSignal) => {});
		expect(manager.getSnapshot("grep_app").state).toBe("closed");
	});

	test("aborts in-flight start when close is requested", async () => {
		const manager = new McpPointerLifecycleManager();

		const starting = manager.start("notion", async (signal: AbortSignal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});

		await manager.close("notion");
		await expect(starting).rejects.toThrow();
		expect(manager.getSnapshot("notion").state).toBe("closed");
	});

	test("aborts quickly when close is requested during retry backoff", async () => {
		const manager = new McpPointerLifecycleManager();
		const started = manager.start("context7", async (_signal: AbortSignal) => {
			throw new Error("boom");
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		const closeStartedAt = Date.now();
		await manager.close("context7");
		const elapsedMs = Date.now() - closeStartedAt;

		await expect(started).rejects.toThrow();
		expect(elapsedMs).toBeLessThan(300);
		expect(manager.getSnapshot("context7").state).toBe("closed");
	});
});
