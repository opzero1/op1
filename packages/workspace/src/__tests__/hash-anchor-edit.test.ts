import { afterEach, describe, expect, test } from "bun:test";
import { join, mkdtemp, rm, tmpdir } from "../bun-compat";
import { buildHashAnchor } from "../hash-anchor/contract";
import { executeHashAnchoredEdit } from "../hash-anchor/edit";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

function makeAnchors(content: string, lineNumbers: number[]): string[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	return lineNumbers.map((lineNumber) =>
		buildHashAnchor(lineNumber, lines[lineNumber - 1] ?? "", {
			previous: lines[lineNumber - 2],
			next: lines[lineNumber],
		}),
	);
}

describe("executeHashAnchoredEdit", () => {
	test("applies anchored replacement when preflight succeeds", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-hash-anchor-edit-"));
		tempRoots.push(root);

		const relativeFilePath = "target.ts";
		const absoluteFilePath = join(root, relativeFilePath);
		const initial = ["function get() {", "  return 1;", "}", ""].join("\n");
		await Bun.write(absoluteFilePath, initial);

		const anchors = makeAnchors(initial, [2]);
		const result = await executeHashAnchoredEdit(
			{
				filePath: relativeFilePath,
				anchors,
				replacement: "  return 2;",
			},
			{ directory: root, enabled: true },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.applied.startLine).toBe(2);
			expect(result.applied.endLine).toBe(2);
		}

		const updated = await Bun.file(absoluteFilePath).text();
		expect(updated).toContain("return 2;");
	});

	test("returns hash mismatch when content drifts", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-hash-anchor-edit-"));
		tempRoots.push(root);

		const relativeFilePath = "target.ts";
		const absoluteFilePath = join(root, relativeFilePath);
		const initial = ["function get() {", "  return 1;", "}", ""].join("\n");
		await Bun.write(absoluteFilePath, initial);

		const anchors = makeAnchors(initial, [2]);
		await Bun.write(
			absoluteFilePath,
			["function get() {", "  return 9;", "}", ""].join("\n"),
		);

		const result = await executeHashAnchoredEdit(
			{
				filePath: relativeFilePath,
				anchors,
				replacement: "  return 2;",
			},
			{ directory: root, enabled: true },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("anchor_hash_mismatch");
		}
	});

	test("returns partial conflict when anchor set validity is mixed", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-hash-anchor-edit-"));
		tempRoots.push(root);

		const relativeFilePath = "target.ts";
		const absoluteFilePath = join(root, relativeFilePath);
		const initial = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join(
			"\n",
		);
		await Bun.write(absoluteFilePath, initial);

		const anchors = makeAnchors(initial, [2, 3]);
		anchors[1] = "3#deadbeef";

		const result = await executeHashAnchoredEdit(
			{
				filePath: relativeFilePath,
				anchors,
				replacement: ["const b = 4;", "const c = 5;"].join("\n"),
			},
			{ directory: root, enabled: true },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("anchor_partial_conflict");
		}
	});

	test("rejects non-contiguous anchor sets", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-hash-anchor-edit-"));
		tempRoots.push(root);

		const relativeFilePath = "target.ts";
		const absoluteFilePath = join(root, relativeFilePath);
		const initial = ["line a", "line b", "line c", "line d", ""].join("\n");
		await Bun.write(absoluteFilePath, initial);

		const anchors = makeAnchors(initial, [2, 4]);
		const result = await executeHashAnchoredEdit(
			{
				filePath: relativeFilePath,
				anchors,
				replacement: "line x",
			},
			{ directory: root, enabled: true },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("hash_anchor_non_contiguous");
		}
	});

	test("enforces structural boundary checks", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-hash-anchor-edit-"));
		tempRoots.push(root);

		const relativeFilePath = "doc.md";
		const absoluteFilePath = join(root, relativeFilePath);
		const initial = ["# Top", "content", "## Child", "nested", ""].join("\n");
		await Bun.write(absoluteFilePath, initial);

		const anchors = makeAnchors(initial, [1, 2, 3]);
		const result = await executeHashAnchoredEdit(
			{
				filePath: relativeFilePath,
				anchors,
				replacement: ["# Top", "updated", "## Child"].join("\n"),
			},
			{ directory: root, enabled: true },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("hash_anchor_boundary_violation");
		}
	});

	test("fails closed when feature flag is disabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "op1-hash-anchor-edit-"));
		tempRoots.push(root);

		const relativeFilePath = "target.ts";
		const absoluteFilePath = join(root, relativeFilePath);
		const initial = ["const value = 1;", ""].join("\n");
		await Bun.write(absoluteFilePath, initial);

		const anchors = makeAnchors(initial, [1]);
		const result = await executeHashAnchoredEdit(
			{
				filePath: relativeFilePath,
				anchors,
				replacement: "const value = 2;",
			},
			{ directory: root, enabled: false },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("hash_anchor_feature_disabled");
		}

		const unchanged = await Bun.file(absoluteFilePath).text();
		expect(unchanged).toBe(initial);
	});
});
