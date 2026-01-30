/**
 * LRU Embedding Cache
 *
 * Caches embeddings by content hash to avoid redundant computation.
 * Uses Map's insertion order for LRU eviction.
 */

import { createHash } from "node:crypto";

export interface EmbeddingCacheOptions {
	/**
	 * Maximum number of entries to cache.
	 * @default 5000
	 */
	maxSize?: number;
}

export interface CacheStats {
	size: number;
	maxSize: number;
	hitRate: number;
	hits: number;
	misses: number;
}

/**
 * LRU cache for embeddings with content-hash keys.
 *
 * Features:
 * - O(1) lookup and insertion
 * - Automatic LRU eviction when at capacity
 * - Content hashing for deduplication
 * - Hit/miss statistics tracking
 */
export class EmbeddingCache {
	private cache: Map<string, number[]> = new Map();
	private readonly maxSize: number;
	private hits = 0;
	private misses = 0;

	constructor(options: EmbeddingCacheOptions = {}) {
		this.maxSize = options.maxSize ?? 5000;
	}

	/**
	 * Generate a hash key for content.
	 * Uses SHA-256 truncated to 16 chars for balance of uniqueness and memory.
	 */
	private hashContent(content: string): string {
		return createHash("sha256").update(content).digest("hex").slice(0, 16);
	}

	/**
	 * Get embedding from cache by content.
	 * Moves entry to end (most recently used) on hit.
	 */
	get(content: string): number[] | undefined {
		const key = this.hashContent(content);
		const value = this.cache.get(key);

		if (value === undefined) {
			this.misses++;
			return undefined;
		}

		// Move to end for LRU ordering
		this.cache.delete(key);
		this.cache.set(key, value);
		this.hits++;

		return value;
	}

	/**
	 * Store embedding in cache.
	 * Evicts oldest entry if at capacity.
	 */
	set(content: string, embedding: number[]): void {
		const key = this.hashContent(content);

		// If key exists, delete first to update LRU order
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			// Evict oldest (first) entry
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(key, embedding);
	}

	/**
	 * Check if content is cached (without affecting LRU order).
	 */
	has(content: string): boolean {
		const key = this.hashContent(content);
		return this.cache.has(key);
	}

	/**
	 * Get multiple embeddings, returning map of content -> embedding.
	 * Only includes entries that exist in cache.
	 */
	getMany(contents: string[]): Map<string, number[]> {
		const results = new Map<string, number[]>();

		for (const content of contents) {
			const embedding = this.get(content);
			if (embedding !== undefined) {
				results.set(content, embedding);
			}
		}

		return results;
	}

	/**
	 * Store multiple embeddings.
	 */
	setMany(entries: Array<{ content: string; embedding: number[] }>): void {
		for (const { content, embedding } of entries) {
			this.set(content, embedding);
		}
	}

	/**
	 * Clear all cached entries.
	 */
	clear(): void {
		this.cache.clear();
		this.hits = 0;
		this.misses = 0;
	}

	/**
	 * Get cache statistics.
	 */
	getStats(): CacheStats {
		const total = this.hits + this.misses;
		return {
			size: this.cache.size,
			maxSize: this.maxSize,
			hitRate: total > 0 ? this.hits / total : 0,
			hits: this.hits,
			misses: this.misses,
		};
	}

	/**
	 * Current number of cached entries.
	 */
	get size(): number {
		return this.cache.size;
	}
}

/**
 * Create a shared cache instance with default settings.
 */
export function createEmbeddingCache(
	options?: EmbeddingCacheOptions,
): EmbeddingCache {
	return new EmbeddingCache(options);
}
