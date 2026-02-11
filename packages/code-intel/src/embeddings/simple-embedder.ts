/**
 * Simple Embedder - Fallback embedder using TF-IDF-like hashing
 * 
 * When HuggingFace models are unavailable, this provides a deterministic
 * embedding based on token hashing. Not as semantically rich, but works
 * offline and is fast.
 */

import type { Embedder } from "./embedder";

// Match all-MiniLM-L6-v2 dimension (384) for consistency
const EMBEDDING_DIM = 384;

/**
 * Simple hash function for strings
 */
function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return hash;
}

/**
 * Tokenize code into meaningful tokens
 */
function tokenize(text: string): string[] {
	// Split on whitespace, punctuation, and camelCase
	return text
		.replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // ACRONYMWord
		.toLowerCase()
		.split(/[\s\W_]+/)
		.filter(t => t.length > 1);
}

/**
 * Create a hash-based embedding for text.
 * Uses locality-sensitive hashing to create similar embeddings for similar text.
 */
function createHashEmbedding(text: string): number[] {
	const tokens = tokenize(text);
	const embedding = new Float32Array(EMBEDDING_DIM).fill(0);

	// Use multiple hash functions for LSH
	for (const token of tokens) {
		const hash1 = hashString(token);
		const hash2 = hashString(token + "_salt1");
		const hash3 = hashString(token + "_salt2");

		// Distribute token influence across multiple dimensions
		const idx1 = Math.abs(hash1) % EMBEDDING_DIM;
		const idx2 = Math.abs(hash2) % EMBEDDING_DIM;
		const idx3 = Math.abs(hash3) % EMBEDDING_DIM;

		// Add contribution (with sign from hash)
		embedding[idx1] += (hash1 > 0 ? 1 : -1) * 0.5;
		embedding[idx2] += (hash2 > 0 ? 1 : -1) * 0.3;
		embedding[idx3] += (hash3 > 0 ? 1 : -1) * 0.2;
	}

	// Add n-gram features for context
	for (let i = 0; i < tokens.length - 1; i++) {
		const bigram = tokens[i] + "_" + tokens[i + 1];
		const hash = hashString(bigram);
		const idx = Math.abs(hash) % EMBEDDING_DIM;
		embedding[idx] += (hash > 0 ? 1 : -1) * 0.4;
	}

	// Normalize to unit vector
	let norm = 0;
	for (let i = 0; i < EMBEDDING_DIM; i++) {
		norm += embedding[i] * embedding[i];
	}
	norm = Math.sqrt(norm);

	if (norm > 0) {
		for (let i = 0; i < EMBEDDING_DIM; i++) {
			embedding[i] /= norm;
		}
	}

	return Array.from(embedding);
}

/**
 * Simple hash-based embedder for fallback scenarios.
 * Produces consistent embeddings without network access.
 */
export class SimpleEmbedder implements Embedder {
	readonly dimension = EMBEDDING_DIM;
	readonly modelId = "simple-hash-embedder";

	async embed(text: string): Promise<number[]> {
		if (!text.trim()) {
			return new Array(this.dimension).fill(0);
		}
		return createHashEmbedding(text);
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		return texts.map(text => {
			if (!text.trim()) {
				return new Array(this.dimension).fill(0);
			}
			return createHashEmbedding(text);
		});
	}
}

/**
 * Create a simple embedder instance
 */
export function createSimpleEmbedder(): SimpleEmbedder {
	return new SimpleEmbedder();
}

/**
 * Auto-select the best available embedder.
 * Tries UniXcoder first, falls back to simple embedder.
 */
export async function createAutoEmbedder(): Promise<Embedder> {
	try {
		// Try to load UniXcoder
		const { createUniXcoderEmbedder, isTransformersAvailable } = await import("./unixcoder");
		
		if (await isTransformersAvailable()) {
			const embedder = createUniXcoderEmbedder();
			
			// Test that it actually works
			try {
				await embedder.embed("test");
				return embedder;
			} catch {
				// UniXcoder failed, fall through to simple embedder
			}
		}
	} catch {
		// UniXcoder not available
	}

	return new SimpleEmbedder();
}
