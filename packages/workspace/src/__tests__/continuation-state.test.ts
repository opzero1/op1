import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createContinuationStateManager } from "../continuation/state";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

async function createTempWorkspace(): Promise<{
	root: string;
	workspaceDir: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-continuation-test-"));
	const workspaceDir = join(root, ".opencode", "workspace");
	await mkdir(workspaceDir, { recursive: true });
	return { root, workspaceDir };
}

describe("continuation state manager", () => {
	test("defaults to continuation allowed when no record exists", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createContinuationStateManager(env.workspaceDir);
		const allowed = await manager.isContinuationAllowed("session-a");
		expect(allowed).toBe(true);
	});

	test("supports stop and continue transitions", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createContinuationStateManager(env.workspaceDir);

		const stopped = await manager.setSessionMode({
			session_id: "session-a",
			mode: "stopped",
			reason: "manual stop",
		});
		expect(stopped.mode).toBe("stopped");

		expect(await manager.isContinuationAllowed("session-a")).toBe(false);

		await manager.setSessionMode({
			session_id: "session-a",
			mode: "running",
		});
		expect(await manager.isContinuationAllowed("session-a")).toBe(true);
	});

	test("honors idempotency keys", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createContinuationStateManager(env.workspaceDir);
		const first = await manager.setSessionMode({
			session_id: "session-a",
			mode: "handoff",
			handoff_to: "reviewer",
			handoff_summary: "handoff summary",
			idempotency_key: "key-1",
		});

		const second = await manager.setSessionMode({
			session_id: "session-a",
			mode: "running",
			idempotency_key: "key-1",
		});

		expect(second.mode).toBe(first.mode);
		expect(second.last_idempotency_key).toBe("key-1");
	});

	test("stores tmux metadata for continuation traceability", async () => {
		const env = await createTempWorkspace();
		tempRoots.push(env.root);

		const manager = createContinuationStateManager(env.workspaceDir);
		const metadata = await manager.setSessionTmuxMetadata({
			session_id: "session-a",
			tmux_session_name: "main",
			tmux_window_name: "op1-project-feature-a",
		});

		expect(metadata.tmux_session_name).toBe("main");
		expect(metadata.tmux_window_name).toBe("op1-project-feature-a");

		const transitioned = await manager.setSessionMode({
			session_id: "session-a",
			mode: "handoff",
			handoff_to: "build",
			handoff_summary: "handoff summary",
		});

		expect(transitioned.tmux_session_name).toBe("main");
		expect(transitioned.tmux_window_name).toBe("op1-project-feature-a");
	});
});
