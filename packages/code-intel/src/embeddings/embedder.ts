/**
 * Embedder Interface
 *
 * Contract for embedding generators. Implementations must provide
 * consistent dimension outputs and support both single and batch operations.
 */

export interface Embedder {
	/**
	 * Generate embedding for a single text.
	 * @param text - The text to embed
	 * @returns Promise resolving to embedding vector
	 */
	embed(text: string): Promise<number[]>;

	/**
	 * Generate embeddings for multiple texts efficiently.
	 * Implementations should optimize for batch processing.
	 * @param texts - Array of texts to embed
	 * @returns Promise resolving to array of embedding vectors
	 */
	embedBatch(texts: string[]): Promise<number[][]>;

	/**
	 * Embedding vector dimension (e.g., 768 for UniXcoder).
	 */
	readonly dimension: number;

	/**
	 * Model identifier (e.g., "microsoft/unixcoder-base").
	 */
	readonly modelId: string;
}

/**
 * Progress callback for model loading operations.
 */
export interface ModelLoadProgress {
	status: "downloading" | "loading" | "ready" | "error";
	progress?: number;
	file?: string;
	message?: string;
}

export type ProgressCallback = (progress: ModelLoadProgress) => void;
