/**
 * Embedder Interface
 *
 * Contract for embedding generators. Implementations must provide
 * consistent dimension outputs and support both single and batch operations.
 */

/**
 * Options for embedding operations.
 * Used by providers that support asymmetric embeddings (e.g., Voyage AI).
 */
export interface EmbedOptions {
	/**
	 * The type of input being embedded.
	 * - 'document': Use when embedding content for indexing/storage
	 * - 'query': Use when embedding search queries for retrieval
	 * Providers that don't support asymmetric embeddings should ignore this.
	 */
	inputType?: 'query' | 'document';
}

export interface Embedder {
	/**
	 * Generate embedding for a single text.
	 * @param text - The text to embed
	 * @param options - Optional embed options (e.g., inputType for asymmetric embeddings)
	 * @returns Promise resolving to embedding vector
	 */
	embed(text: string, options?: EmbedOptions): Promise<number[]>;

	/**
	 * Generate embeddings for multiple texts efficiently.
	 * Implementations should optimize for batch processing.
	 * @param texts - Array of texts to embed
	 * @param options - Optional embed options (e.g., inputType for asymmetric embeddings)
	 * @returns Promise resolving to array of embedding vectors
	 */
	embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>;

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
