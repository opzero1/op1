import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VoyageAIClient } from "voyageai";
import {
	createVoyageReranker,
	isVoyageRerankerAvailable,
} from "../query/voyage-reranker";
import type { RerankItem } from "../query/reranker";

type VoyageRerankResponse = Awaited<ReturnType<VoyageAIClient["rerank"]>>;

describe("Voyage reranker", () => {
	const originalApiKey = process.env.VOYAGE_AI_API_KEY;
	const originalRerank = VoyageAIClient.prototype.rerank;

	beforeEach(() => {
		delete process.env.VOYAGE_AI_API_KEY;
	});

	afterEach(() => {
		process.env.VOYAGE_AI_API_KEY = originalApiKey;
		VoyageAIClient.prototype.rerank = originalRerank;
	});

	test("availability check respects explicit key and env", () => {
		expect(isVoyageRerankerAvailable()).toBe(false);
		expect(isVoyageRerankerAvailable("explicit-key")).toBe(true);

		process.env.VOYAGE_AI_API_KEY = "env-key";
		expect(isVoyageRerankerAvailable()).toBe(true);
	});

	test("createVoyageReranker throws when API key is missing", () => {
		expect(() => createVoyageReranker()).toThrow(/VOYAGE_AI_API_KEY/);
	});

	test("rerank short-circuits empty candidate list", async () => {
		let called = false;
		VoyageAIClient.prototype.rerank = async () => {
			called = true;
			throw new Error("should not be called for empty items");
		};

		const reranker = createVoyageReranker({ apiKey: "test-key" });
		const results = await reranker.rerank([], { query: "test", limit: 10 });

		expect(results).toEqual([]);
		expect(called).toBe(false);
	});

	test("rerank maps Voyage relevance scores and keeps overflow items", async () => {
		VoyageAIClient.prototype.rerank = async () => {
			return {
				data: [
					{ index: 1, relevanceScore: 0.9 },
					{ index: 0, relevanceScore: 0.4 },
				],
			} as VoyageRerankResponse;
		};

		const reranker = createVoyageReranker({
			apiKey: "test-key",
			maxCandidates: 2,
		});

		const items: RerankItem[] = [
			{
				id: "a",
				content: "alpha",
				file_path: "a.ts",
				initialScore: 0.8,
				granularity: "symbol",
			},
			{
				id: "b",
				content: "beta",
				file_path: "b.ts",
				initialScore: 0.7,
				granularity: "chunk",
			},
			{
				id: "c",
				content: "gamma",
				file_path: "c.ts",
				initialScore: 0.6,
				granularity: "file",
			},
		];

		const results = await reranker.rerank(items, { query: "test", limit: 3 });

		expect(results).toHaveLength(3);
		expect(results[0]).toMatchObject({ id: "b", finalScore: 0.9, granularity: "chunk" });
		expect(results[1]).toMatchObject({ id: "a", finalScore: 0.4, granularity: "symbol" });
		expect(results[2]).toMatchObject({ id: "c", finalScore: 0, granularity: "file" });
	});

	test("rerank throws when Voyage returns empty data", async () => {
		VoyageAIClient.prototype.rerank = async () => {
			return { data: [] } as VoyageRerankResponse;
		};

		const reranker = createVoyageReranker({ apiKey: "test-key" });
		const items: RerankItem[] = [
			{
				id: "a",
				content: "alpha",
				file_path: "a.ts",
				initialScore: 0.8,
				granularity: "symbol",
			},
		];

		return expect(reranker.rerank(items, { query: "test", limit: 1 })).rejects.toThrow(
			/empty response/i,
		);
	});
});
