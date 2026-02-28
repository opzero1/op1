import { describe, expect, test } from "bun:test";
import {
	createHashAnchorReadEnhancerHook,
	enhanceReadOutputWithAnchors,
} from "../hooks/hash-anchor-read-enhancer.js";

describe("hash anchor read enhancer", () => {
	test("enhances numbered read output lines with deterministic anchors", () => {
		const output = ["1: alpha", "2: beta", "3: gamma"].join("\n");
		const enhanced = enhanceReadOutputWithAnchors(output);
		const lines = enhanced.split("\n");

		expect(lines[0]).toMatch(/^1#[0-9a-f]{8}\| alpha$/);
		expect(lines[1]).toMatch(/^2#[0-9a-f]{8}\| beta$/);
		expect(lines[2]).toMatch(/^3#[0-9a-f]{8}\| gamma$/);
	});

	test("preserves non-numbered lines", () => {
		const output = ["<path>/tmp/file</path>", "1: alpha", "(End of file)"].join(
			"\n",
		);
		const enhanced = enhanceReadOutputWithAnchors(output);
		const lines = enhanced.split("\n");

		expect(lines[0]).toBe("<path>/tmp/file</path>");
		expect(lines[1]).toMatch(/^1#[0-9a-f]{8}\| alpha$/);
		expect(lines[2]).toBe("(End of file)");
	});

	test("hook no-ops when disabled", async () => {
		const hook = createHashAnchorReadEnhancerHook({ enabled: false });
		const payload = { output: "1: alpha" };

		await hook({ tool: "read" }, payload);

		expect(payload.output).toBe("1: alpha");
	});

	test("hook no-ops for non-read tools", async () => {
		const hook = createHashAnchorReadEnhancerHook({ enabled: true });
		const payload = { output: "1: alpha" };

		await hook({ tool: "grep" }, payload);

		expect(payload.output).toBe("1: alpha");
	});
});
