import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";

import {
	BLOCKED_FILE_PATH,
	createEditSafetyAfterHook,
	createEditSafetyBeforeHook,
	detectHashlineBoundaryViolation,
	resetEditSafetyState,
} from "../hooks/edit-safety";

let tempRoots: string[] = [];

afterEach(async () => {
	resetEditSafetyState();
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots = [];
});

describe("detectHashlineBoundaryViolation", () => {
	test("returns null for non-structural edits", () => {
		const violation = detectHashlineBoundaryViolation("hello", "world");
		expect(violation).toBeNull();
	});

	test("flags multi-heading boundary edits", () => {
		const oldString = "# Title\ntext\n## Subheading";
		const violation = detectHashlineBoundaryViolation(
			oldString,
			"# Title\nupdated\n## Subheading",
		);
		expect(violation).toContain("multiple markdown heading anchors");
	});

	test("flags unbalanced code fence edits", () => {
		const violation = detectHashlineBoundaryViolation(
			"```ts\nconst x = 1",
			"```ts\nconst x = 2",
		);
		expect(violation).toContain("unbalanced code-fence anchors");
	});
});

describe("edit safety hooks", () => {
	test("blocks edit on existing file when not read", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-edit-safety-test-"));
		tempRoots.push(root);

		const filePath = join(root, "file.md");
		await Bun.write(filePath, "hello\n");

		const beforeHook = createEditSafetyBeforeHook(root);
		const afterHook = createEditSafetyAfterHook(root);

		const beforeOutput = {
			args: {
				filePath,
				oldString: "hello",
				newString: "world",
			},
		};

		await beforeHook(
			{ tool: "edit", sessionID: "session-a", callID: "call-a" },
			beforeOutput,
		);

		expect(beforeOutput.args.filePath).toBe(BLOCKED_FILE_PATH);

		const afterOutput = { output: "Error: blocked" };
		await afterHook(
			{
				tool: "edit",
				sessionID: "session-a",
				callID: "call-a",
				args: beforeOutput.args,
			},
			afterOutput,
		);

		expect(afterOutput.output).toContain(
			"EDIT SAFETY GUARD BLOCKED THE OPERATION",
		);
	});

	test("allows edit after successful read", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-edit-safety-test-"));
		tempRoots.push(root);

		const filePath = join(root, "file.md");
		await Bun.write(filePath, "hello\n");

		const beforeHook = createEditSafetyBeforeHook(root);
		const afterHook = createEditSafetyAfterHook(root);

		await afterHook(
			{
				tool: "read",
				sessionID: "session-b",
				callID: "read-b",
				args: { filePath },
			},
			{ output: "hello\n" },
		);

		const beforeOutput = {
			args: {
				filePath,
				oldString: "hello",
				newString: "world",
			},
		};

		await beforeHook(
			{ tool: "edit", sessionID: "session-b", callID: "call-b" },
			beforeOutput,
		);

		expect(beforeOutput.args.filePath).toBe(filePath);
	});

	test("blocks stale reads when TTL is exceeded", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-edit-safety-test-"));
		tempRoots.push(root);

		const filePath = join(root, "file.md");
		await Bun.write(filePath, "hello\n");

		const beforeHook = createEditSafetyBeforeHook(root, { readTtlMs: 0 });
		const afterHook = createEditSafetyAfterHook(root);

		await afterHook(
			{
				tool: "read",
				sessionID: "session-c",
				callID: "read-c",
				args: { filePath },
			},
			{ output: "hello\n" },
		);

		await new Promise((resolve) => setTimeout(resolve, 2));

		const beforeOutput = {
			args: {
				filePath,
				oldString: "hello",
				newString: "world",
			},
		};

		await beforeHook(
			{ tool: "edit", sessionID: "session-c", callID: "call-c" },
			beforeOutput,
		);

		expect(beforeOutput.args.filePath).toBe(BLOCKED_FILE_PATH);
	});

	test("enforces read-before-write for hash_anchored_edit", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-edit-safety-test-"));
		tempRoots.push(root);

		const filePath = join(root, "file.ts");
		await Bun.write(filePath, "const value = 1;\n");

		const beforeHook = createEditSafetyBeforeHook(root);

		const beforeOutput = {
			args: {
				filePath,
				anchors: "1#deadbeef",
				replacement: "const value = 2;",
			},
		};

		await beforeHook(
			{
				tool: "hash_anchored_edit",
				sessionID: "session-hash",
				callID: "call-hash",
			},
			beforeOutput,
		);

		expect(beforeOutput.args.filePath).toBe(BLOCKED_FILE_PATH);
	});
});
