import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { WorkspacePlugin } from "../index";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

type SessionCompactTool = {
	execute: (
		args: { session_id?: string },
		toolCtx: { sessionID?: string },
	) => Promise<string>;
};

function createMockClient(input?: {
	summarizeError?: Error;
	onSummarize?: () => void;
}) {
	return {
		app: {
			log: async () => {},
		},
		session: {
			get: async (args: { path: { id: string } }) => ({
				data: { id: args.path.id },
			}),
			create: async () => ({ data: { id: "mock-child-session" } }),
			promptAsync: async () => ({}),
			messages: async () => ({ data: [] }),
			abort: async () => ({}),
			summarize: async () => {
				if (input?.summarizeError) throw input.summarizeError;
				input?.onSummarize?.();
				return {};
			},
		},
	};
}

async function createHarness(input?: {
	summarizeError?: Error;
	onSummarize?: () => void;
}) {
	const root = await mkdtemp(join(tmpdir(), "op1-manual-compact-test-"));
	tempRoots.push(root);
	await mkdir(join(root, ".opencode"), { recursive: true });

	const plugin = await WorkspacePlugin({
		directory: root,
		client: createMockClient(input),
	} as never);

	const sessionCompact = plugin.tool?.session_compact as unknown as
		| SessionCompactTool
		| undefined;
	if (!sessionCompact) {
		throw new Error("session_compact tool is missing");
	}

	return { sessionCompact };
}

describe("session_compact tool", () => {
	test("summarizes the current session", async () => {
		let summarizeCount = 0;
		const harness = await createHarness({
			onSummarize: () => {
				summarizeCount += 1;
			},
		});

		const result = await harness.sessionCompact.execute(
			{},
			{ sessionID: "session-a" },
		);

		expect(result).toContain('"session_id": "session-a"');
		expect(result).toContain('"compacted": true');
		expect(summarizeCount).toBe(1);
	});

	test("returns a fail-soft error payload when summarize fails", async () => {
		const harness = await createHarness({
			summarizeError: new Error("provider unavailable"),
		});

		const result = await harness.sessionCompact.execute(
			{},
			{ sessionID: "session-b" },
		);

		expect(result).toContain('"session_id": "session-b"');
		expect(result).toContain('"compacted": false');
		expect(result).toContain("provider unavailable");
	});
});
