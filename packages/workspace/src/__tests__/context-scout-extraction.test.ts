import { describe, expect, test } from "bun:test";
import { extractPatternCandidates } from "../context-scout/extraction";

describe("extractPatternCandidates", () => {
	test("extracts normalized grep candidates", () => {
		const output = [
			"/tmp/demo.ts:",
			"  Line 18: async function delegateTask(input) {",
		].join("\n");

		const candidates = extractPatternCandidates([{ tool: "grep", output }]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.source_tool).toBe("grep");
		expect(candidates[0]?.file_path).toBe("/tmp/demo.ts");
		expect(candidates[0]?.pattern).toContain("delegateTask");
	});

	test("extracts glob path candidates", () => {
		const output = [
			"/repo/packages/workspace/src/index.ts",
			"/repo/packages/workspace/src/delegation/state.ts",
		].join("\n");

		const candidates = extractPatternCandidates([{ tool: "glob", output }]);
		expect(candidates).toHaveLength(2);
		expect(candidates.every((entry) => entry.source_tool === "glob")).toBe(
			true,
		);
	});

	test("extracts ast-grep snippet candidates", () => {
		const output =
			"packages/workspace/src/index.ts:120:5: const hook = createSafeRuntimeHook(name, factory, config);";

		const candidates = extractPatternCandidates([
			{ tool: "ast_grep_search", output },
		]);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.source_tool).toBe("ast_grep");
		expect(candidates[0]?.pattern).toContain("createSafeRuntimeHook");
	});

	test("extracts symbol candidates from lsp JSON payloads", () => {
		const output = JSON.stringify([
			{
				name: "createDelegationStateManager",
				filePath: "packages/workspace/src/delegation/state.ts",
			},
		]);

		const candidates = extractPatternCandidates([
			{ tool: "lsp_symbols", output },
		]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.source_tool).toBe("lsp");
		expect(candidates[0]?.symbol).toBe("createDelegationStateManager");
	});

	test("deduplicates repeated candidates and keeps highest confidence", () => {
		const output = [
			"/tmp/demo.ts:",
			"  Line 12: const selected = routeCategory(task);",
			"  Line 30: const selected = routeCategory(task);",
		].join("\n");

		const candidates = extractPatternCandidates([{ tool: "grep", output }]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.pattern).toContain("routeCategory");
	});
});
