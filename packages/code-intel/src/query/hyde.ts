/**
 * HyDE (Hypothetical Document Embeddings) Generator
 *
 * Generates hypothetical code snippets from natural language queries
 * to improve semantic search by bridging the query-document gap.
 *
 * Based on: "Precise Zero-Shot Dense Retrieval without Relevance Labels" (Gao et al., 2022)
 */

import type { Embedder } from "../embeddings";

// ============================================================================
// Types
// ============================================================================

export interface HyDEGenerator {
	/**
	 * Generate a hypothetical code document from a natural language query
	 */
	generateHypothetical(query: string): Promise<string>;

	/**
	 * Generate embedding for the hypothetical document
	 */
	generateHyDEEmbedding(query: string, embedder: Embedder): Promise<number[]>;
}

export interface HyDEOptions {
	/** Language hint for code generation */
	language?: string;
	/** Maximum length of generated code */
	maxLength?: number;
}

// ============================================================================
// Template-based HyDE Generator
// ============================================================================

/**
 * Creates a template-based HyDE generator that uses heuristics
 * to generate hypothetical code from queries.
 *
 * This is a lightweight alternative to LLM-based generation,
 * suitable for fast, local execution without API calls.
 */
export function createTemplateHyDEGenerator(): HyDEGenerator {
	return {
		async generateHypothetical(query: string): Promise<string> {
			const normalized = query.toLowerCase().trim();

			// Extract key terms from query
			const terms = extractKeyTerms(normalized);
			const functionName = generateFunctionName(terms);
			const docstring = generateDocstring(query);

			// Detect likely language from query
			const language = detectLanguage(normalized);

			// Generate hypothetical code based on patterns
			if (language === "python") {
				return generatePythonHypothetical(functionName, docstring, terms);
			}

			// Default to TypeScript
			return generateTypeScriptHypothetical(functionName, docstring, terms);
		},

		async generateHyDEEmbedding(query: string, embedder: Embedder): Promise<number[]> {
			const hypothetical = await this.generateHypothetical(query);
			return embedder.embed(hypothetical);
		},
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

function extractKeyTerms(query: string): string[] {
	// Remove common stop words and extract meaningful terms
	const stopWords = new Set([
		"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
		"have", "has", "had", "do", "does", "did", "will", "would", "could",
		"should", "may", "might", "must", "shall", "can", "need", "dare",
		"ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
		"from", "as", "into", "through", "during", "before", "after", "above",
		"below", "between", "under", "again", "further", "then", "once", "here",
		"there", "when", "where", "why", "how", "all", "each", "few", "more",
		"most", "other", "some", "such", "no", "nor", "not", "only", "own",
		"same", "so", "than", "too", "very", "just", "that", "this", "these",
		"those", "what", "which", "who", "whom", "find", "get", "make", "create",
		"function", "method", "class", "code", "implement", "write",
	]);

	return query
		.replace(/[^\w\s]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !stopWords.has(word));
}

function generateFunctionName(terms: string[]): string {
	if (terms.length === 0) return "processData";

	// Convert terms to camelCase function name
	const name = terms
		.slice(0, 3)
		.map((term, i) => (i === 0 ? term : term.charAt(0).toUpperCase() + term.slice(1)))
		.join("");

	return name || "processData";
}

function generateDocstring(query: string): string {
	// Clean up the query for use as a docstring
	return query.charAt(0).toUpperCase() + query.slice(1);
}

function detectLanguage(query: string): "typescript" | "python" {
	const pythonIndicators = ["python", "django", "flask", "pandas", "numpy", "def ", "pip"];
	const tsIndicators = ["typescript", "javascript", "react", "node", "npm", "async", "await"];

	const pyScore = pythonIndicators.filter((ind) => query.includes(ind)).length;
	const tsScore = tsIndicators.filter((ind) => query.includes(ind)).length;

	return pyScore > tsScore ? "python" : "typescript";
}

function generateTypeScriptHypothetical(
	functionName: string,
	docstring: string,
	terms: string[],
): string {
	const params = terms.slice(0, 2).map((t) => `${t}: string`).join(", ");
	const body = terms.length > 0
		? `// ${docstring}\n\treturn ${terms[0]};`
		: `// ${docstring}\n\treturn result;`;

	return `/**
 * ${docstring}
 */
export function ${functionName}(${params || "input: string"}): string {
	${body}
}`;
}

function generatePythonHypothetical(
	functionName: string,
	docstring: string,
	terms: string[],
): string {
	const snakeName = functionName.replace(/([A-Z])/g, "_$1").toLowerCase();
	const params = terms.slice(0, 2).join(", ") || "input_data";
	const body = terms.length > 0 ? `return ${terms[0]}` : "return result";

	return `def ${snakeName}(${params}):
    """${docstring}"""
    ${body}`;
}

// ============================================================================
// LLM-based HyDE Generator (for future use)
// ============================================================================

export interface LLMProvider {
	generate(prompt: string): Promise<string>;
}

/**
 * Creates an LLM-based HyDE generator for higher quality hypothetical documents.
 * Requires an LLM provider (e.g., OpenAI, Anthropic, local model).
 */
export function createLLMHyDEGenerator(llmProvider: LLMProvider): HyDEGenerator {
	const HYDE_PROMPT = `You are a code generation assistant. Given a natural language query about code, generate a hypothetical code snippet that would match this query. The code should be realistic, well-structured, and directly relevant to the query.

Query: {query}

Generate a concise, relevant code snippet (function, class, or code block) that would match this query. Only output the code, no explanations.`;

	return {
		async generateHypothetical(query: string): Promise<string> {
			const prompt = HYDE_PROMPT.replace("{query}", query);
			return llmProvider.generate(prompt);
		},

		async generateHyDEEmbedding(query: string, embedder: Embedder): Promise<number[]> {
			const hypothetical = await this.generateHypothetical(query);
			return embedder.embed(hypothetical);
		},
	};
}
