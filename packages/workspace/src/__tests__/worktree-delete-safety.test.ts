import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdir, mkdtemp, rm, stat, tmpdir } from "../bun-compat";
import { runCommand } from "../utils";
import { createWorktreeTools } from "../worktree/tools";

const tempRoots: string[] = [];
const originalHome = Bun.env.HOME;

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;

	if (originalHome === undefined) {
		delete Bun.env.HOME;
	} else {
		Bun.env.HOME = originalHome;
	}
});

async function createRepositoryFixture(): Promise<{
	root: string;
	repo: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "op1-worktree-delete-safety-"));
	tempRoots.push(root);
	Bun.env.HOME = root;

	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });

	await runCommand(["git", "init"], repo);
	await runCommand(["git", "config", "user.email", "test@example.com"], repo);
	await runCommand(["git", "config", "user.name", "OP7 Test"], repo);

	await Bun.write(join(repo, "base.txt"), "base\n");
	await Bun.write(join(repo, ".gitignore"), "*.cache\n");
	await runCommand(["git", "add", "base.txt", ".gitignore"], repo);
	await runCommand(["git", "commit", "-m", "init"], repo);

	return { root, repo };
}

async function createDirtyWorktree(input: {
	repo: string;
	root: string;
	branch: string;
	marker: string;
}): Promise<string> {
	const worktreePath = join(input.root, input.marker);
	await runCommand(
		["git", "worktree", "add", "-b", input.branch, worktreePath],
		input.repo,
	);

	await Bun.write(join(worktreePath, "base.txt"), `dirty-${input.branch}\n`);
	return worktreePath;
}

describe("worktree delete safety", () => {
	test("aborts deletion when snapshot commit fails", async () => {
		const { root, repo } = await createRepositoryFixture();
		const branch = "feature/snapshot-fail";
		const worktreePath = await createDirtyWorktree({
			repo,
			root,
			branch,
			marker: "wt-snapshot-fail",
		});

		const preCommitHook = join(repo, ".git", "hooks", "pre-commit");
		await Bun.write(preCommitHook, "#!/bin/sh\nexit 1\n");
		await runCommand(["chmod", "+x", preCommitHook], "/");

		const tools = createWorktreeTools(repo, "worktree-delete-safety");
		const result = await tools.worktree_delete.execute(
			{ branch, snapshot: true, force: false },
			{} as never,
		);

		expect(result).toContain("Failed to snapshot changes before deletion");
		expect((await stat(worktreePath)).isDirectory()).toBe(true);

		const listed = await runCommand(
			["git", "worktree", "list", "--porcelain"],
			repo,
		);
		expect(listed).toContain(worktreePath);
	});

	test("does not force-delete dirty worktree unless explicitly forced", async () => {
		const { root, repo } = await createRepositoryFixture();
		const branch = "feature/no-force-delete";
		const worktreePath = await createDirtyWorktree({
			repo,
			root,
			branch,
			marker: "wt-no-force",
		});

		const tools = createWorktreeTools(repo, "worktree-delete-safety");
		const blocked = await tools.worktree_delete.execute(
			{ branch, snapshot: false, force: false },
			{} as never,
		);

		expect(blocked).toContain("Failed to delete worktree");
		expect((await stat(worktreePath)).isDirectory()).toBe(true);

		const forced = await tools.worktree_delete.execute(
			{ branch, snapshot: false, force: true },
			{} as never,
		);
		expect(forced).toContain("✅ Worktree deleted");
		await expect(stat(worktreePath)).rejects.toBeTruthy();
	});

	test("blocks deletion when only ignored files exist unless force=true", async () => {
		const { root, repo } = await createRepositoryFixture();
		const branch = "feature/ignored-only";
		const worktreePath = join(root, "wt-ignored-only");
		await runCommand(
			["git", "worktree", "add", "-b", branch, worktreePath],
			repo,
		);

		await Bun.write(join(worktreePath, "local.cache"), "ignored-data\n");

		const tools = createWorktreeTools(repo, "worktree-delete-safety");
		const blocked = await tools.worktree_delete.execute(
			{ branch, snapshot: true, force: false },
			{} as never,
		);
		expect(blocked).toContain("ignored files that cannot be snapshotted");
		expect((await stat(worktreePath)).isDirectory()).toBe(true);

		const forced = await tools.worktree_delete.execute(
			{ branch, snapshot: true, force: true },
			{} as never,
		);
		expect(forced).toContain("✅ Worktree deleted");
		await expect(stat(worktreePath)).rejects.toBeTruthy();
	});

	test("rejects nested worktree creation from an already-linked worktree root", async () => {
		const { root, repo } = await createRepositoryFixture();
		const worktreePath = await createDirtyWorktree({
			repo,
			root,
			branch: "feature/existing-linked-worktree",
			marker: "wt-linked-root",
		});

		const tools = createWorktreeTools(worktreePath, "worktree-delete-safety");
		const result = await tools.worktree_create.execute(
			{ branch: "feature/nested-attempt", open_terminal: false },
			{ sessionID: "child-session" } as never,
		);

		expect(result).toContain("Cannot create a nested worktree");
	});
});
