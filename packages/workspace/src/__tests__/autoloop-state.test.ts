import { describe, expect, test } from "bun:test";
import {
	buildAutoloopStatusSnapshot,
	createAutoloopIterationEntry,
	getLatestAutoloopConfig,
	getLatestAutoloopIteration,
	getNextAutoloopIterationNumber,
	parseAutoloopStateFile,
	parseAutoloopStateLine,
	serializeAutoloopStateEntry,
} from "../autoloop/state";

describe("autoloop state helpers", () => {
	test("parses config and iteration entries from jsonl content", () => {
		const parsed = parseAutoloopStateFile(
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
					max_iterations: 50,
					stop_conditions: ["user stop", ".paused present"],
				}),
				"",
				JSON.stringify({
					type: "iteration",
					iteration: 3,
					timestamp: "2026-03-19T00:10:00Z",
					action: "Added a helper",
					files_changed: ["packages/workspace/src/autoloop/state.ts"],
					verification: [
						"bun test packages/workspace/src/__tests__/autoloop-state.test.ts",
					],
					status: "passed",
					outcome: "keep",
					next_step: "Use the helper in future tooling.",
				}),
			].join("\n"),
		);

		expect(parsed.issues).toHaveLength(0);
		expect(parsed.entries).toHaveLength(2);
		expect(parsed.entries[0]).toMatchObject({
			type: "config",
			max_iterations: 50,
		});
		expect(parsed.entries[1]).toMatchObject({
			type: "iteration",
			iteration: 3,
			outcome: "keep",
		});
	});

	test("reports invalid json and schema mismatches without dropping valid entries", () => {
		const parsed = parseAutoloopStateFile(
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
				}),
				"{not-json}",
				JSON.stringify({
					type: "iteration",
					iteration: 1,
					timestamp: "2026-03-19T00:10:00Z",
					action: "Missing outcome",
					status: "passed",
					next_step: "Fix schema",
				}),
			].join("\n"),
		);

		expect(parsed.entries).toHaveLength(1);
		expect(parsed.issues).toEqual([
			{ line: 2, reason: "invalid json", raw: "{not-json}" },
			{
				line: 3,
				reason: "schema mismatch",
				raw: JSON.stringify({
					type: "iteration",
					iteration: 1,
					timestamp: "2026-03-19T00:10:00Z",
					action: "Missing outcome",
					status: "passed",
					next_step: "Fix schema",
				}),
			},
		]);
	});

	test("defaults iteration arrays and can return the latest iteration", () => {
		const configLine = parseAutoloopStateLine(
			JSON.stringify({
				type: "config",
				timestamp: "2026-03-19T00:00:00Z",
				goal: "Improve the harness",
			}),
		);
		const iterationLine = parseAutoloopStateLine(
			JSON.stringify({
				type: "iteration",
				iteration: 4,
				timestamp: "2026-03-19T00:10:00Z",
				action: "Added a helper",
				status: "passed",
				outcome: "keep",
				next_step: "Keep going",
			}),
		);

		expect(configLine?.type).toBe("config");
		expect(iterationLine).toMatchObject({
			type: "iteration",
			files_changed: [],
			verification: [],
		});
		expect(
			getLatestAutoloopIteration([configLine!, iterationLine!])?.iteration,
		).toBe(4);
		expect(
			getLatestAutoloopConfig([configLine!, iterationLine!]),
		).toMatchObject({
			type: "config",
		});
	});

	test("serializes normalized entries for append-only logging", () => {
		const serialized = serializeAutoloopStateEntry({
			type: "iteration",
			iteration: 5,
			timestamp: "2026-03-19T00:10:00Z",
			action: "Logged a verified checkpoint",
			files_changed: ["state.jsonl"],
			verification: [
				"bun test packages/workspace/src/__tests__/autoloop-state.test.ts",
			],
			status: "passed",
			outcome: "keep",
			next_step: "Record the next step",
		});

		expect(parseAutoloopStateLine(serialized)).toMatchObject({
			type: "iteration",
			iteration: 5,
		});
	});

	test("builds a status snapshot that keeps plan lifecycle separate from pause signals", () => {
		const parsed = parseAutoloopStateFile(
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
					slug: "agent-harness",
					max_iterations: 50,
					next_step: "Read the latest checkpoint",
				}),
				JSON.stringify({
					type: "iteration",
					iteration: 6,
					timestamp: "2026-03-19T00:10:00Z",
					action: "Added a status helper",
					status: "passed",
					outcome: "keep",
					next_step: "Keep iterating",
				}),
			].join("\n"),
		);

		expect(
			buildAutoloopStatusSnapshot(parsed.entries, {
				paused: true,
				continuation: {
					mode: "running",
					updated_at: "2026-03-19T00:11:00Z",
				},
			}),
		).toEqual({
			lifecycle_source: "dedicated-plan",
			slug: "agent-harness",
			paused: true,
			continuation_mode: "running",
			effective_mode: "paused",
			continuation_updated_at: "2026-03-19T00:11:00Z",
			continuation_reason: undefined,
			latest_iteration: 6,
			max_iterations: 50,
			next_step: "Keep iterating",
		});
	});

	test("defaults continuation mode to running and falls back to config next_step", () => {
		const parsed = parseAutoloopStateFile(
			JSON.stringify({
				type: "config",
				timestamp: "2026-03-19T00:00:00Z",
				goal: "Improve the harness",
				next_step: "Inspect the next candidate",
			}),
		);

		expect(buildAutoloopStatusSnapshot(parsed.entries)).toMatchObject({
			lifecycle_source: "dedicated-plan",
			paused: false,
			continuation_mode: "running",
			effective_mode: "running",
			next_step: "Inspect the next candidate",
		});
	});

	test("allocates the next iteration from the highest existing checkpoint", () => {
		const parsed = parseAutoloopStateFile(
			[
				JSON.stringify({
					type: "config",
					timestamp: "2026-03-19T00:00:00Z",
					goal: "Improve the harness",
				}),
				JSON.stringify({
					type: "iteration",
					iteration: 16,
					timestamp: "2026-03-19T00:10:00Z",
					action: "First writer",
					status: "passed",
					outcome: "keep",
					next_step: "Keep iterating",
				}),
				JSON.stringify({
					type: "iteration",
					iteration: 16,
					timestamp: "2026-03-19T00:11:00Z",
					action: "Second writer",
					status: "passed",
					outcome: "keep",
					next_step: "Still keep iterating",
				}),
			].join("\n"),
		);

		expect(getNextAutoloopIterationNumber(parsed.entries)).toBe(17);
		expect(
			createAutoloopIterationEntry(parsed.entries, {
				timestamp: "2026-03-19T00:12:00Z",
				action: "Locked checkpoint writer",
				files_changed: ["state.jsonl"],
				verification: ["bun test autoloop"],
				status: "passed",
				outcome: "keep",
				next_step: "Keep going",
			}),
		).toMatchObject({
			type: "iteration",
			iteration: 17,
			files_changed: ["state.jsonl"],
			verification: ["bun test autoloop"],
		});
	});
});
