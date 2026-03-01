import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { createWorktreeDB } from "../worktree/state";

let tempRoots: string[] = [];
const originalHome = Bun.env.HOME;

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];

	if (originalHome === undefined) {
		delete Bun.env.HOME;
		return;
	}

	Bun.env.HOME = originalHome;
});

describe("worktree state manager", () => {
	test("tracks active session enter and leave lifecycle", async () => {
		const homeRoot = await mkdtemp(join(tmpdir(), "op1-worktree-state-test-"));
		tempRoots.push(homeRoot);
		Bun.env.HOME = homeRoot;

		const db = await createWorktreeDB("project-lifecycle");
		db.addSession("session-a", "/tmp/worktree-a", "feature/a");

		db.enterSession("session-a");
		const entered = db.getLifecycleState();
		expect(entered?.current_session_id).toBe("session-a");
		expect(entered?.current_worktree_path).toBe("/tmp/worktree-a");
		expect(entered?.last_entered_at).toBeDefined();

		const didLeave = db.leaveSession("session-a");
		expect(didLeave).toBe(true);

		const left = db.getLifecycleState();
		expect(left?.current_session_id).toBeNull();
		expect(left?.current_worktree_path).toBeNull();
		expect(left?.last_left_at).toBeDefined();

		db.close();
	});

	test("requires force when a different session clears lifecycle state", async () => {
		const homeRoot = await mkdtemp(join(tmpdir(), "op1-worktree-state-test-"));
		tempRoots.push(homeRoot);
		Bun.env.HOME = homeRoot;

		const db = await createWorktreeDB("project-lifecycle-force");
		db.addSession("session-a", "/tmp/worktree-a", "feature/a");
		db.addSession("session-b", "/tmp/worktree-b", "feature/b");

		db.enterSession("session-a");

		const blocked = db.leaveSession("session-b");
		expect(blocked).toBe(false);
		expect(db.getLifecycleState()?.current_session_id).toBe("session-a");

		const forced = db.leaveSession("session-b", true);
		expect(forced).toBe(true);
		expect(db.getLifecycleState()?.current_session_id).toBeNull();

		db.close();
	});
});
