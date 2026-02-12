/**
 * Tests for refresh performance optimizations in index-manager.ts:
 * 1. Worktree exclusion — parsing `git worktree list --porcelain` output
 * 2. Skip-embedding via content_hash — reuse cached embeddings for unchanged chunks
 * 3. Bounded concurrency (semaphore) — limit parallel async tasks
 * 4. Embedding buffer accumulation — collect chunks across files, flush in batch
 *
 * These optimizations are closure-internal to createIndexManager, so we test
 * the *algorithms* in isolation rather than importing private functions.
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// 1. Worktree Exclusion
// ---------------------------------------------------------------------------

/**
 * Mirrors the parsing logic in getInProjectWorktrees():
 * - Parse `git worktree list --porcelain` output
 * - Skip the main worktree (matching workspaceRoot exactly)
 * - Include only worktrees whose path starts with `workspaceRoot/`
 * - Return relative paths
 */
function parseWorktreePorcelain(
	porcelainOutput: string,
	workspaceRoot: string,
): string[] {
	const normalizedRoot = workspaceRoot.endsWith("/")
		? workspaceRoot
		: `${workspaceRoot}/`;
	const worktreePaths: string[] = [];

	for (const line of porcelainOutput.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const wtPath = line.slice("worktree ".length).trim();

		// Skip the main worktree (exact match with or without trailing slash)
		if (
			wtPath === workspaceRoot ||
			wtPath === workspaceRoot.replace(/\/$/, "")
		) {
			continue;
		}

		// Only include worktrees inside workspaceRoot
		if (wtPath.startsWith(normalizedRoot)) {
			const relativePath = wtPath.slice(normalizedRoot.length);
			if (relativePath.length > 0) {
				worktreePaths.push(relativePath);
			}
		}
	}

	return worktreePaths;
}

describe("Worktree exclusion", () => {
	test("parses porcelain output and returns only in-project worktrees", () => {
		const porcelainOutput = `worktree /workspace/main
HEAD abc123def456789
branch refs/heads/main

worktree /workspace/main/feature-branch
HEAD def456abc789012
branch refs/heads/feature

worktree /external/other-worktree
HEAD ghi789def012345
branch refs/heads/other
`;
		const result = parseWorktreePorcelain(porcelainOutput, "/workspace/main");

		expect(result).toEqual(["feature-branch"]);
	});

	test("returns empty array when only the main worktree exists", () => {
		const porcelainOutput = `worktree /workspace/main
HEAD abc123def456789
branch refs/heads/main
`;
		const result = parseWorktreePorcelain(porcelainOutput, "/workspace/main");

		expect(result).toEqual([]);
	});

	test("handles multiple in-project worktrees", () => {
		const porcelainOutput = `worktree /repo
HEAD aaa111
branch refs/heads/main

worktree /repo/wt-fix-auth
HEAD bbb222
branch refs/heads/fix-auth

worktree /repo/wt-refactor-api
HEAD ccc333
branch refs/heads/refactor-api

worktree /other-repo/unrelated
HEAD ddd444
branch refs/heads/unrelated
`;
		const result = parseWorktreePorcelain(porcelainOutput, "/repo");

		expect(result).toEqual(["wt-fix-auth", "wt-refactor-api"]);
	});

	test("handles workspaceRoot with trailing slash", () => {
		const porcelainOutput = `worktree /workspace/main
HEAD abc123
branch refs/heads/main

worktree /workspace/main/feature
HEAD def456
branch refs/heads/feature
`;
		// Root with trailing slash — should still work identically
		const result = parseWorktreePorcelain(
			porcelainOutput,
			"/workspace/main/",
		);

		expect(result).toEqual(["feature"]);
	});

	test("excludes external worktrees that share a prefix but not a directory boundary", () => {
		// "/repo-extra" starts with "/repo" but is NOT inside "/repo/"
		const porcelainOutput = `worktree /repo
HEAD aaa111
branch refs/heads/main

worktree /repo-extra/something
HEAD bbb222
branch refs/heads/extra
`;
		const result = parseWorktreePorcelain(porcelainOutput, "/repo");

		expect(result).toEqual([]);
	});

	test("returns empty array for empty porcelain output", () => {
		const result = parseWorktreePorcelain("", "/workspace/main");

		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. Skip-Embedding via content_hash
// ---------------------------------------------------------------------------

describe("Skip-embedding via content_hash", () => {
	test("unchanged chunks reuse cached embeddings instead of re-embedding", () => {
		const oldChunkEmbeddingsByHash = new Map<
			string,
			{ embedding: number[]; granularity: string }
		>();
		oldChunkEmbeddingsByHash.set("hash_abc", {
			embedding: [0.1, 0.2, 0.3],
			granularity: "chunk",
		});
		oldChunkEmbeddingsByHash.set("hash_def", {
			embedding: [0.4, 0.5, 0.6],
			granularity: "file",
		});

		const newChunks = [
			{
				id: "new_id_1",
				content: "same content",
				chunk_type: "block",
				content_hash: "hash_abc",
			},
			{
				id: "new_id_2",
				content: "changed content",
				chunk_type: "block",
				content_hash: "hash_xyz",
			},
			{
				id: "new_id_3",
				content: "same file content",
				chunk_type: "file",
				content_hash: "hash_def",
			},
		];

		const chunksNeedingEmbedding: typeof newChunks = [];
		const cachedEntries: Array<{
			id: string;
			embedding: number[];
			granularity: string;
		}> = [];

		for (const chunk of newChunks) {
			const cached = oldChunkEmbeddingsByHash.get(chunk.content_hash);
			if (cached) {
				cachedEntries.push({
					id: chunk.id,
					embedding: cached.embedding,
					granularity: cached.granularity,
				});
			} else {
				chunksNeedingEmbedding.push(chunk);
			}
		}

		// 2 chunks had cached embeddings, 1 needs re-embedding
		expect(cachedEntries).toHaveLength(2);
		expect(chunksNeedingEmbedding).toHaveLength(1);

		// Cached entries use new chunk ID but old embedding
		expect(cachedEntries[0].id).toBe("new_id_1");
		expect(cachedEntries[0].embedding).toEqual([0.1, 0.2, 0.3]);
		expect(cachedEntries[1].id).toBe("new_id_3");
		expect(cachedEntries[1].embedding).toEqual([0.4, 0.5, 0.6]);

		// Only changed chunk needs embedding
		expect(chunksNeedingEmbedding[0].content_hash).toBe("hash_xyz");
	});

	test("all chunks need embedding when no old embeddings exist", () => {
		const oldChunkEmbeddingsByHash = new Map<
			string,
			{ embedding: number[]; granularity: string }
		>();

		const newChunks = [
			{
				id: "id_1",
				content: "a",
				chunk_type: "block",
				content_hash: "hash_1",
			},
			{
				id: "id_2",
				content: "b",
				chunk_type: "file",
				content_hash: "hash_2",
			},
		];

		const chunksNeedingEmbedding: typeof newChunks = [];
		const cachedEntries: Array<{
			id: string;
			embedding: number[];
			granularity: string;
		}> = [];

		for (const chunk of newChunks) {
			const cached = oldChunkEmbeddingsByHash.get(chunk.content_hash);
			if (cached) {
				cachedEntries.push({
					id: chunk.id,
					embedding: cached.embedding,
					granularity: cached.granularity,
				});
			} else {
				chunksNeedingEmbedding.push(chunk);
			}
		}

		expect(cachedEntries).toHaveLength(0);
		expect(chunksNeedingEmbedding).toHaveLength(2);
	});

	test("duplicate content hashes share the same cached embedding", () => {
		const oldChunkEmbeddingsByHash = new Map<
			string,
			{ embedding: number[]; granularity: string }
		>();
		oldChunkEmbeddingsByHash.set("same_hash", {
			embedding: [1, 2, 3],
			granularity: "chunk",
		});

		const newChunks = [
			{
				id: "chunk_a",
				content: "dup",
				chunk_type: "block",
				content_hash: "same_hash",
			},
			{
				id: "chunk_b",
				content: "dup",
				chunk_type: "block",
				content_hash: "same_hash",
			},
		];

		const cachedEntries: Array<{ id: string; embedding: number[] }> = [];
		for (const chunk of newChunks) {
			const cached = oldChunkEmbeddingsByHash.get(chunk.content_hash);
			if (cached) {
				cachedEntries.push({ id: chunk.id, embedding: cached.embedding });
			}
		}

		expect(cachedEntries).toHaveLength(2);
		expect(cachedEntries[0].id).toBe("chunk_a");
		expect(cachedEntries[1].id).toBe("chunk_b");
		// Both get the same embedding vector
		expect(cachedEntries[0].embedding).toEqual(cachedEntries[1].embedding);
	});

	test("first-seen hash wins when building the old embeddings cache", () => {
		// Mirrors index-manager.ts lines 332-337: first chunk with a given content_hash
		// stores its embedding; subsequent chunks with the same hash are skipped.
		const oldChunkEmbeddingsByHash = new Map<
			string,
			{ embedding: number[]; granularity: string }
		>();

		const oldChunks = [
			{ content_hash: "hash_a", id: "old_1" },
			{ content_hash: "hash_a", id: "old_2" }, // duplicate hash
			{ content_hash: "hash_b", id: "old_3" },
		];

		// Simulate the lookup: if not already cached, store the embedding
		const embeddingLookup: Record<string, number[]> = {
			old_1: [1, 1, 1],
			old_2: [2, 2, 2], // would be different if we didn't skip
			old_3: [3, 3, 3],
		};

		for (const oldChunk of oldChunks) {
			if (!oldChunkEmbeddingsByHash.has(oldChunk.content_hash)) {
				const vec = embeddingLookup[oldChunk.id];
				if (vec) {
					oldChunkEmbeddingsByHash.set(oldChunk.content_hash, {
						embedding: vec,
						granularity: "chunk",
					});
				}
			}
		}

		// hash_a should map to old_1's embedding, not old_2's
		expect(oldChunkEmbeddingsByHash.get("hash_a")?.embedding).toEqual([
			1, 1, 1,
		]);
		expect(oldChunkEmbeddingsByHash.get("hash_b")?.embedding).toEqual([
			3, 3, 3,
		]);
		expect(oldChunkEmbeddingsByHash.size).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 3. Bounded Concurrency (Semaphore)
// ---------------------------------------------------------------------------

/**
 * Mirrors createSemaphore() from index-manager.ts lines 225-244.
 * Re-implemented here since it's closure-internal.
 */
function createSemaphore(maxConcurrency: number) {
	let running = 0;
	const queue: Array<() => void> = [];

	async function acquire(): Promise<void> {
		if (running < maxConcurrency) {
			running++;
			return;
		}
		await new Promise<void>((resolve) => queue.push(resolve));
		running++;
	}

	function release(): void {
		running--;
		const next = queue.shift();
		if (next) next();
	}

	return { acquire, release, getRunning: () => running };
}

describe("Bounded concurrency (semaphore)", () => {
	test("limits concurrency to maxConcurrency", async () => {
		const semaphore = createSemaphore(3);
		let peakConcurrency = 0;
		let currentConcurrency = 0;

		const tasks = Array.from({ length: 10 }, (_, i) => async () => {
			await semaphore.acquire();
			currentConcurrency++;
			peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
			// Simulate async work
			await new Promise((r) => setTimeout(r, 10));
			currentConcurrency--;
			semaphore.release();
			return i;
		});

		const results = await Promise.all(tasks.map((fn) => fn()));

		expect(peakConcurrency).toBeLessThanOrEqual(3);
		expect(results).toHaveLength(10);
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test("semaphore(1) enforces sequential execution", async () => {
		const semaphore = createSemaphore(1);
		const order: number[] = [];

		const tasks = [0, 1, 2].map((i) => async () => {
			await semaphore.acquire();
			order.push(i);
			await new Promise((r) => setTimeout(r, 5));
			semaphore.release();
		});

		await Promise.all(tasks.map((fn) => fn()));
		expect(order).toEqual([0, 1, 2]);
	});

	test("error in one task does not block subsequent tasks", async () => {
		const semaphore = createSemaphore(2);
		const completed: number[] = [];

		const tasks = [0, 1, 2, 3].map((i) => async () => {
			await semaphore.acquire();
			try {
				if (i === 1) throw new Error("task 1 failed");
				await new Promise((r) => setTimeout(r, 5));
				completed.push(i);
			} finally {
				semaphore.release();
			}
		});

		const results = await Promise.allSettled(tasks.map((fn) => fn()));

		// Task 1 failed, others succeeded
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
		expect(completed).toContain(0);
		expect(completed).toContain(2);
		expect(completed).toContain(3);
		expect(completed).not.toContain(1);
	});

	test("running count returns to zero after all tasks complete", async () => {
		const semaphore = createSemaphore(4);

		const tasks = Array.from({ length: 6 }, () => async () => {
			await semaphore.acquire();
			await new Promise((r) => setTimeout(r, 5));
			semaphore.release();
		});

		await Promise.all(tasks.map((fn) => fn()));

		expect(semaphore.getRunning()).toBe(0);
	});

	test("semaphore with maxConcurrency equal to task count runs all in parallel", async () => {
		const semaphore = createSemaphore(5);
		let peakConcurrency = 0;
		let currentConcurrency = 0;

		const tasks = Array.from({ length: 5 }, () => async () => {
			await semaphore.acquire();
			currentConcurrency++;
			peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
			await new Promise((r) => setTimeout(r, 10));
			currentConcurrency--;
			semaphore.release();
		});

		await Promise.all(tasks.map((fn) => fn()));

		// All 5 should run simultaneously
		expect(peakConcurrency).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// 4. Embedding Buffer Accumulation
// ---------------------------------------------------------------------------

describe("Embedding buffer accumulation", () => {
	test("chunks from multiple files accumulate in a single buffer", () => {
		const buffer: Array<{ id: string; text: string }> = [];

		// Simulate 3 files each producing 3 chunks
		for (let file = 0; file < 3; file++) {
			const fileChunks = Array.from({ length: 3 }, (_, i) => ({
				id: `file${file}_chunk${i}`,
				text: `content ${file}_${i}`,
			}));
			buffer.push(...fileChunks);
		}

		expect(buffer).toHaveLength(9);
		expect(buffer[0].id).toBe("file0_chunk0");
		expect(buffer[8].id).toBe("file2_chunk2");
	});

	test("buffer flush via splice clears all pending items", () => {
		const buffer: Array<{ id: string }> = [];

		// Accumulate many chunks (simulating a large codebase)
		for (let i = 0; i < 600; i++) {
			buffer.push({ id: `chunk_${i}` });
		}

		expect(buffer.length).toBeGreaterThanOrEqual(512);

		// Flush via splice — same pattern used in the production code
		const batch = buffer.splice(0, buffer.length);

		expect(batch).toHaveLength(600);
		expect(buffer).toHaveLength(0);
	});

	test("only fulfilled results contribute chunks to the buffer", () => {
		// Mirrors the Promise.allSettled pattern in index-manager.ts lines 844-863
		type FileResult = {
			filePath: string;
			result: { chunksNeedingEmbedding: Array<{ id: string; text: string }> };
		};

		const settledResults: PromiseSettledResult<FileResult>[] = [
			{
				status: "fulfilled",
				value: {
					filePath: "a.ts",
					result: {
						chunksNeedingEmbedding: [
							{ id: "a_1", text: "fn a" },
							{ id: "a_2", text: "fn b" },
						],
					},
				},
			},
			{
				status: "rejected",
				reason: new Error("parse error in b.ts"),
			},
			{
				status: "fulfilled",
				value: {
					filePath: "c.ts",
					result: {
						chunksNeedingEmbedding: [{ id: "c_1", text: "fn c" }],
					},
				},
			},
		];

		const pendingEmbeddingChunks: Array<{ id: string; text: string }> = [];
		for (const settled of settledResults) {
			if (settled.status === "fulfilled") {
				pendingEmbeddingChunks.push(
					...settled.value.result.chunksNeedingEmbedding,
				);
			}
		}

		// b.ts failed — its chunks should not appear
		expect(pendingEmbeddingChunks).toHaveLength(3);
		expect(pendingEmbeddingChunks.map((c) => c.id)).toEqual([
			"a_1",
			"a_2",
			"c_1",
		]);
	});

	test("empty files contribute nothing to the buffer", () => {
		const buffer: Array<{ id: string }> = [];

		// Some files produce chunks, some don't
		const fileBatches = [
			[{ id: "chunk_1" }],
			[], // empty file
			[{ id: "chunk_2" }, { id: "chunk_3" }],
			[], // another empty file
		];

		for (const batch of fileBatches) {
			if (batch.length > 0) {
				buffer.push(...batch);
			}
		}

		expect(buffer).toHaveLength(3);
		expect(buffer.map((c) => c.id)).toEqual([
			"chunk_1",
			"chunk_2",
			"chunk_3",
		]);
	});
});
