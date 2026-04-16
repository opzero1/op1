import { afterEach, describe, expect, test } from "bun:test";
import {
	checkPreemptiveCompaction,
	markCompactionStateDirty,
	resetCompactionState,
	runManualCompaction,
} from "../hooks/preemptive-compaction";

afterEach(() => {
	resetCompactionState();
});

function createClient(input: {
	messages: Array<{
		info?: { role?: string; tokens?: { input?: number; output?: number } };
	}>;
	onSummarize?: () => void;
}) {
	return {
		session: {
			messages: async () => ({ data: input.messages }),
			summarize: async () => {
				input.onSummarize?.();
				return {};
			},
		},
	} as const;
}

describe("preemptive compaction", () => {
	test("triggers summarization when token usage crosses threshold", async () => {
		let summarizeCount = 0;
		const client = createClient({
			messages: [
				{
					info: {
						role: "assistant",
						tokens: { input: 150_000, output: 20_000 },
					},
				},
			],
			onSummarize: () => {
				summarizeCount += 1;
			},
		});

		const triggered = await checkPreemptiveCompaction(
			client,
			"session-trigger",
			"/tmp",
		);

		expect(triggered).toBe(true);
		expect(summarizeCount).toBe(1);
	});

	test("skips summarization when usage is below threshold", async () => {
		let summarizeCount = 0;
		const client = createClient({
			messages: [
				{
					info: { role: "assistant", tokens: { input: 10_000, output: 2_000 } },
				},
			],
			onSummarize: () => {
				summarizeCount += 1;
			},
		});

		const triggered = await checkPreemptiveCompaction(
			client,
			"session-skip",
			"/tmp",
		);

		expect(triggered).toBe(false);
		expect(summarizeCount).toBe(0);
	});

	test("honors cooldown until state is marked dirty", async () => {
		let summarizeCount = 0;
		const client = createClient({
			messages: [
				{
					info: {
						role: "assistant",
						tokens: { input: 160_000, output: 20_000 },
					},
				},
			],
			onSummarize: () => {
				summarizeCount += 1;
			},
		});

		expect(
			await checkPreemptiveCompaction(client, "session-dirty", "/tmp"),
		).toBe(true);
		expect(
			await checkPreemptiveCompaction(client, "session-dirty", "/tmp"),
		).toBe(false);

		markCompactionStateDirty("session-dirty");

		expect(
			await checkPreemptiveCompaction(client, "session-dirty", "/tmp"),
		).toBe(true);
		expect(summarizeCount).toBe(2);
	});

	test("manual compaction starts cooldown for follow-up threshold checks", async () => {
		let summarizeCount = 0;
		const client = createClient({
			messages: [
				{
					info: {
						role: "assistant",
						tokens: { input: 160_000, output: 20_000 },
					},
				},
			],
			onSummarize: () => {
				summarizeCount += 1;
			},
		});

		const manual = await runManualCompaction(client, "session-manual", "/tmp");
		expect(manual.compacted).toBe(true);

		const triggered = await checkPreemptiveCompaction(
			client,
			"session-manual",
			"/tmp",
		);

		expect(triggered).toBe(false);
		expect(summarizeCount).toBe(1);
	});
});
