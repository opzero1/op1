import { expect, test } from "bun:test";
import { formatFullSession } from "../messages.js";
import type { TaskRecord } from "../state.js";

function createTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id: "calm-river-spark",
		root_session_id: "root-session",
		parent_session_id: "parent-session",
		child_session_id: "child-session-1",
		description: "Implement helper",
		agent: "build",
		prompt: "Finish the helper.",
		run_in_background: true,
		status: "succeeded",
		created_at: "2026-03-19T00:00:00.000Z",
		updated_at: "2026-03-19T00:01:00.000Z",
		completed_at: "2026-03-19T00:01:00.000Z",
		...overrides,
	};
}

test("formatFullSession includes persisted result when it differs from the latest assistant text", () => {
	const output = formatFullSession(
		[
			{
				id: "msg-1",
				info: {
					role: "assistant",
					time: { created: "2026-03-19T00:01:00.000Z" },
				},
				parts: [{ type: "text", text: "background result" }],
			},
		],
		{
			task: createTask({
				result:
					"background result\n\nVerified with `npm test` and merged branch op1/coder/task-1 into main.",
			}),
		},
	);

	expect(output).toContain("Latest result:");
	expect(output).toContain(
		"Verified with `npm test` and merged branch op1/coder/task-1 into main.",
	);
	expect(output).toContain("### assistant @ 2026-03-19T00:01:00.000Z");
});

test("formatFullSession skips latest result duplication when it matches the assistant text", () => {
	const output = formatFullSession(
		[
			{
				id: "msg-1",
				info: {
					role: "assistant",
					time: { created: "2026-03-19T00:01:00.000Z" },
				},
				parts: [{ type: "text", text: "background result" }],
			},
		],
		{
			task: createTask({ result: "background result" }),
		},
	);

	expect(output).not.toContain("Latest result:");
});

test("formatFullSession includes root and session model variants when available", () => {
	const output = formatFullSession(
		[
			{
				id: "msg-1",
				info: {
					role: "user",
					time: { created: "2026-03-19T00:00:00.000Z" },
					model: {
						providerID: "openai",
						modelID: "gpt-5.3-codex",
						variant: "high",
					},
				},
				parts: [{ type: "text", text: "Implement the fix." }],
			},
		],
		{
			task: createTask({
				root_model: {
					providerID: "openai",
					modelID: "gpt-5.4",
					variant: "xhigh",
				},
			}),
		},
	);

	expect(output).toContain("Root model: openai/gpt-5.4");
	expect(output).toContain("Root variant: xhigh");
	expect(output).toContain("Session model: openai/gpt-5.3-codex");
	expect(output).toContain("Session variant: high");
});
