import { describe, expect, test } from "bun:test";
import {
	buildHashAnchor,
	parseHashAnchor,
	validateHashAnchor,
} from "../hash-anchor/contract.js";

describe("hash anchor contract", () => {
	test("parses valid anchor", () => {
		const anchor = parseHashAnchor("12#deadbeef");

		expect(anchor).not.toBeNull();
		expect(anchor?.line).toBe(12);
		expect(anchor?.hash).toBe("deadbeef");
	});

	test("rejects invalid anchor format", () => {
		expect(parseHashAnchor("line-12")).toBeNull();
		expect(parseHashAnchor("12#nothex!!")).toBeNull();
		expect(parseHashAnchor("0#deadbeef")).toBeNull();
	});

	test("builds deterministic anchors with context", () => {
		const first = buildHashAnchor(4, "const a = 1;", {
			previous: "function demo() {",
			next: "return a;",
		});

		const second = buildHashAnchor(4, "const a = 1;", {
			previous: "function demo() {",
			next: "return a;",
		});

		expect(first).toBe(second);
	});

	test("validates matching anchor", () => {
		const anchor = buildHashAnchor(2, "return value;", {
			previous: "function get() {",
			next: "}",
		});

		const result = validateHashAnchor({
			anchor,
			lineContent: "return value;",
			lineNumber: 2,
			lineCount: 5,
			context: {
				previous: "function get() {",
				next: "}",
			},
		});

		expect(result.ok).toBe(true);
	});

	test("returns hash mismatch on changed content", () => {
		const anchor = buildHashAnchor(2, "return value;", {
			previous: "function get() {",
			next: "}",
		});

		const result = validateHashAnchor({
			anchor,
			lineContent: "return changed;",
			lineNumber: 2,
			lineCount: 5,
			context: {
				previous: "function get() {",
				next: "}",
			},
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("anchor_hash_mismatch");
		}
	});

	test("returns stale line when line number diverges", () => {
		const anchor = buildHashAnchor(3, "return value;");
		const result = validateHashAnchor({
			anchor,
			lineContent: "return value;",
			lineNumber: 4,
			lineCount: 10,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("anchor_stale_line");
		}
	});

	test("returns out-of-range line error", () => {
		const anchor = buildHashAnchor(8, "line");
		const result = validateHashAnchor({
			anchor,
			lineContent: "line",
			lineNumber: 8,
			lineCount: 4,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("anchor_line_out_of_range");
		}
	});

	test("returns partial conflict when requested", () => {
		const anchor = buildHashAnchor(2, "line");
		const result = validateHashAnchor({
			anchor,
			lineContent: "line",
			lineNumber: 2,
			lineCount: 2,
			partialConflict: true,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("anchor_partial_conflict");
		}
	});
});
