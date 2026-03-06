import { describe, expect, test } from "bun:test";
import { createToolMetadataStore } from "../tool-metadata.js";

describe("tool metadata store", () => {
	test("consumes metadata once per session/call pair", () => {
		const store = createToolMetadataStore();
		store.storeToolMetadata("ses_parent", "call_1", {
			title: "Explore code",
			metadata: { sessionId: "ses_child" },
		});

		const first = store.consumeToolMetadata("ses_parent", "call_1");
		const second = store.consumeToolMetadata("ses_parent", "call_1");

		expect(first?.title).toBe("Explore code");
		expect(first?.metadata?.sessionId).toBe("ses_child");
		expect(second).toBeUndefined();
	});

	test("isolates entries by session and call id", () => {
		const store = createToolMetadataStore();
		store.storeToolMetadata("ses_1", "call_a", {
			title: "Task A",
			metadata: { sessionId: "child_a" },
		});
		store.storeToolMetadata("ses_1", "call_b", {
			title: "Task B",
			metadata: { sessionId: "child_b" },
		});
		store.storeToolMetadata("ses_2", "call_a", {
			title: "Task C",
			metadata: { sessionId: "child_c" },
		});

		expect(store.consumeToolMetadata("ses_1", "call_a")?.title).toBe("Task A");
		expect(store.consumeToolMetadata("ses_1", "call_b")?.title).toBe("Task B");
		expect(store.consumeToolMetadata("ses_2", "call_a")?.title).toBe("Task C");
	});

	test("overwrites existing metadata for the same key", () => {
		const store = createToolMetadataStore();
		store.storeToolMetadata("ses_parent", "call_1", {
			title: "Old",
			metadata: { sessionId: "old" },
		});
		store.storeToolMetadata("ses_parent", "call_1", {
			title: "New",
			metadata: { sessionId: "new", reference: "ref:new" },
		});

		const value = store.consumeToolMetadata("ses_parent", "call_1");
		expect(value?.title).toBe("New");
		expect(value?.metadata?.sessionId).toBe("new");
		expect(value?.metadata?.reference).toBe("ref:new");
	});
});
