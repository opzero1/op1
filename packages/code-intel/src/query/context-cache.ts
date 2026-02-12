/**
 * Context Cache - LRU cache with TTL for search results
 *
 * Provides fast follow-up queries by caching:
 * - Search results
 * - Embeddings
 * - Context strings
 */

// ============================================================================
// Types
// ============================================================================

export interface CacheEntry<T> {
	value: T;
	timestamp: number;
	hits: number;
}

export interface ContextCacheConfig {
	/** Maximum entries in cache (default: 100) */
	maxEntries?: number;
	/** TTL in milliseconds (default: 5 minutes) */
	ttlMs?: number;
}

export interface ContextCacheStats {
	size: number;
	maxSize: number;
	hits: number;
	misses: number;
	hitRate: number;
	oldestEntryAge: number;
}

export interface ContextCache<T> {
	/** Get cached value */
	get(key: string): T | null;

	/** Set cached value */
	set(key: string, value: T): void;

	/** Check if key exists and is valid */
	has(key: string): boolean;

	/** Invalidate specific key */
	invalidate(key: string): void;

	/** Invalidate all keys matching pattern */
	invalidatePattern(pattern: RegExp): number;

	/** Invalidate keys for a file path */
	invalidateByFile(filePath: string): number;

	/** Clear all entries */
	clear(): void;

	/** Get cache statistics */
	getStats(): ContextCacheStats;
}

// ============================================================================
// LRU Cache Implementation
// ============================================================================

export function createContextCache<T>(
	config: ContextCacheConfig = {},
): ContextCache<T> {
	const { maxEntries = 100, ttlMs = 5 * 60 * 1000 } = config;

	const cache = new Map<string, CacheEntry<T>>();
	let hits = 0;
	let misses = 0;

	function isExpired(entry: CacheEntry<T>): boolean {
		return Date.now() - entry.timestamp > ttlMs;
	}

	function evictOldest(): void {
		if (cache.size <= maxEntries) return;

		// Find and remove oldest entry
		let oldestKey: string | null = null;
		let oldestTime = Infinity;

		for (const [key, entry] of cache) {
			if (entry.timestamp < oldestTime) {
				oldestTime = entry.timestamp;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			cache.delete(oldestKey);
		}
	}

	function cleanup(): void {
		// Remove expired entries
		for (const [key, entry] of cache) {
			if (isExpired(entry)) {
				cache.delete(key);
			}
		}
	}

	return {
		get(key: string): T | null {
			const entry = cache.get(key);

			if (!entry) {
				misses++;
				return null;
			}

			if (isExpired(entry)) {
				cache.delete(key);
				misses++;
				return null;
			}

			// Update hit count and move to end (LRU)
			entry.hits++;
			cache.delete(key);
			cache.set(key, entry);

			hits++;
			return entry.value;
		},

		set(key: string, value: T): void {
			// Remove if exists to update position
			cache.delete(key);

			// Add new entry
			cache.set(key, {
				value,
				timestamp: Date.now(),
				hits: 0,
			});

			// Evict if over capacity
			evictOldest();
		},

		has(key: string): boolean {
			const entry = cache.get(key);
			if (!entry) return false;

			if (isExpired(entry)) {
				cache.delete(key);
				return false;
			}

			return true;
		},

		invalidate(key: string): void {
			cache.delete(key);
		},

		invalidatePattern(pattern: RegExp): number {
			let count = 0;
			for (const key of cache.keys()) {
				if (pattern.test(key)) {
					cache.delete(key);
					count++;
				}
			}
			return count;
		},

		invalidateByFile(filePath: string): number {
			// Keys that contain the file path should be invalidated
			const pattern = new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
			return this.invalidatePattern(pattern);
		},

		clear(): void {
			cache.clear();
			hits = 0;
			misses = 0;
		},

		getStats(): ContextCacheStats {
			cleanup();

			let oldestAge = 0;
			const now = Date.now();

			for (const entry of cache.values()) {
				const age = now - entry.timestamp;
				if (age > oldestAge) {
					oldestAge = age;
				}
			}

			const total = hits + misses;

			return {
				size: cache.size,
				maxSize: maxEntries,
				hits,
				misses,
				hitRate: total > 0 ? hits / total : 0,
				oldestEntryAge: oldestAge,
			};
		},
	};
}

// ============================================================================
// Query Cache Key Generation
// ============================================================================

/**
 * Generate a cache key from query parameters
 */
export function generateCacheKey(params: {
	query: string;
	branch: string;
	granularity?: string;
	limit?: number;
	filePatterns?: string[];
	pathPrefix?: string;
	rerankerType?: string;
	enableReranking?: boolean;
}): string {
	const normalized = {
		q: params.query.toLowerCase().trim(),
		b: params.branch,
		p: params.pathPrefix ?? "",
		g: params.granularity ?? "auto",
		l: params.limit ?? 50,
		f: (params.filePatterns ?? []).sort().join(","),
		r: params.enableReranking ? (params.rerankerType ?? "bm25") : "none",
	};

	return JSON.stringify(normalized);
}

// ============================================================================
// Embedding Cache
// ============================================================================

export interface EmbeddingCache {
	/** Get cached embedding */
	get(text: string): number[] | null;

	/** Set cached embedding */
	set(text: string, embedding: number[]): void;

	/** Clear all embeddings */
	clear(): void;

	/** Get stats */
	getStats(): ContextCacheStats;
}

/**
 * Creates a cache specifically for embeddings
 * Uses text hash as key to handle large texts efficiently
 */
export function createEmbeddingCache(
	config: ContextCacheConfig = {},
): EmbeddingCache {
	const cache = createContextCache<number[]>({
		maxEntries: config.maxEntries ?? 500,
		ttlMs: config.ttlMs ?? 30 * 60 * 1000, // 30 minutes for embeddings
	});

	function hashText(text: string): string {
		// Simple hash for cache key
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			const char = text.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return `emb:${hash.toString(16)}:${text.length}`;
	}

	return {
		get(text: string): number[] | null {
			const key = hashText(text);
			return cache.get(key);
		},

		set(text: string, embedding: number[]): void {
			const key = hashText(text);
			cache.set(key, embedding);
		},

		clear(): void {
			cache.clear();
		},

		getStats(): ContextCacheStats {
			return cache.getStats();
		},
	};
}
