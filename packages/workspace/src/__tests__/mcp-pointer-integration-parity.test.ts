import { describe, expect, test } from "bun:test";
import { resolveCompatibilitySource } from "../interop/mcp-pointer-contract";

describe("mcp pointer integration parity matrix", () => {
	test("legacy-only mode resolves legacy source when available", () => {
		expect(
			resolveCompatibilitySource({
				mode: "legacy-only",
				pointerAvailable: true,
				legacyAvailable: true,
				requirement: "optional",
			}),
		).toEqual({ ok: true, source: "legacy" });
	});

	test("pointer-only mode fails closed for missing required server", () => {
		expect(
			resolveCompatibilitySource({
				mode: "pointer-only",
				pointerAvailable: false,
				legacyAvailable: true,
				requirement: "required",
			}),
		).toEqual({ ok: false, code: "required_unavailable" });
	});

	test("mixed mode prioritizes pointer then falls back to legacy", () => {
		expect(
			resolveCompatibilitySource({
				mode: "mixed",
				pointerAvailable: true,
				legacyAvailable: true,
				requirement: "optional",
			}),
		).toEqual({ ok: true, source: "pointer" });

		expect(
			resolveCompatibilitySource({
				mode: "mixed",
				pointerAvailable: false,
				legacyAvailable: true,
				requirement: "optional",
			}),
		).toEqual({ ok: true, source: "legacy" });
	});
});
