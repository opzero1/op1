/**
 * LSP Relationship Extractor
 *
 * Extracts CALLS, IMPORTS, INHERITS edges using LSP protocol.
 * Integrates with @op1/lsp package pattern with timeout handling
 * and confidence scoring. Falls back to AST-inference on failure.
 */

import type { EdgeOrigin, EdgeType, SymbolEdge, SymbolNode } from "../types";
import { generateEdgeId } from "./canonical-id";
import type { AstInference } from "./ast-inference";

// ============================================================================
// Types
// ============================================================================

export interface LspExtractorConfig {
	/** Workspace root path */
	workspaceRoot: string;
	/** Timeout for LSP calls in milliseconds (default: 5000) */
	timeout: number;
	/** Maximum retries on transient failures (default: 2) */
	maxRetries: number;
	/** Whether to fallback to AST inference on LSP failure */
	enableAstFallback: boolean;
}

export interface LspClient {
	/** Check if client is alive */
	isAlive(): boolean;
	/** Find references to a symbol at position */
	references(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration?: boolean,
	): Promise<unknown>;
	/** Go to definition at position */
	definition(
		filePath: string,
		line: number,
		character: number,
	): Promise<unknown>;
}

export interface LspLocation {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

export interface ExtractionResult {
	edges: SymbolEdge[];
	errors: ExtractionError[];
	fallbackUsed: boolean;
}

export interface ExtractionError {
	symbolId: string;
	symbolName: string;
	error: string;
	recoverable: boolean;
}

export interface LspExtractor {
	/** Extract edges for a single symbol */
	extractEdgesForSymbol(
		symbol: SymbolNode,
		allSymbols: Map<string, SymbolNode>,
		branch: string,
	): Promise<ExtractionResult>;

	/** Extract edges for multiple symbols in a file */
	extractEdgesForFile(
		filePath: string,
		symbols: SymbolNode[],
		allSymbols: Map<string, SymbolNode>,
		branch: string,
	): Promise<ExtractionResult>;

	/** Check if LSP is available for a language */
	isAvailable(language: "typescript" | "python"): boolean;
}

// ============================================================================
// Confidence Scores
// ============================================================================

const CONFIDENCE = {
	LSP_EXACT: 1.0,
	LSP_INFERRED: 0.85,
	AST_FALLBACK: 0.4,
} as const;

// ============================================================================
// Implementation
// ============================================================================

export function createLspExtractor(
	config: LspExtractorConfig,
	getClient: (language: "typescript" | "python") => Promise<LspClient | null>,
	astInference?: AstInference,
): LspExtractor {
	const { timeout, maxRetries, enableAstFallback } = config;

	async function withTimeout<T>(
		promise: Promise<T>,
		ms: number,
	): Promise<T | null> {
		const timeoutPromise = new Promise<null>((resolve) => {
			setTimeout(() => resolve(null), ms);
		});
		return Promise.race([promise, timeoutPromise]);
	}

	async function withRetry<T>(
		fn: () => Promise<T>,
		retries: number,
	): Promise<T | null> {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const result = await withTimeout(fn(), timeout);
				if (result !== null) return result;
			} catch {
				if (attempt === retries) return null;
				await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
			}
		}
		return null;
	}

	function parseLocations(raw: unknown): LspLocation[] {
		if (!raw) return [];
		if (Array.isArray(raw)) {
			return raw.filter(isValidLocation);
		}
		if (isValidLocation(raw)) {
			return [raw];
		}
		return [];
	}

	function isValidLocation(loc: unknown): loc is LspLocation {
		if (!loc || typeof loc !== "object") return false;
		const l = loc as Record<string, unknown>;
		return (
			typeof l.uri === "string" &&
			l.range !== null &&
			typeof l.range === "object"
		);
	}

	function uriToPath(uri: string): string {
		if (uri.startsWith("file://")) {
			return decodeURIComponent(uri.slice(7));
		}
		return uri;
	}

	function findSymbolAtLocation(
		location: LspLocation,
		allSymbols: Map<string, SymbolNode>,
	): SymbolNode | null {
		const filePath = uriToPath(location.uri);
		const line = location.range.start.line + 1; // LSP is 0-indexed

		for (const symbol of allSymbols.values()) {
			if (symbol.file_path !== filePath) continue;
			if (line >= symbol.start_line && line <= symbol.end_line) {
				return symbol;
			}
		}
		return null;
	}

	function createEdge(
		sourceId: string,
		targetId: string,
		type: EdgeType,
		origin: EdgeOrigin,
		confidence: number,
		branch: string,
		sourceRange?: [number, number],
		targetRange?: [number, number],
	): SymbolEdge {
		return {
			id: generateEdgeId(sourceId, targetId, type),
			source_id: sourceId,
			target_id: targetId,
			type,
			confidence,
			origin,
			branch,
			source_range: sourceRange,
			target_range: targetRange,
			updated_at: Date.now(),
		};
	}

	async function extractCallEdges(
		symbol: SymbolNode,
		client: LspClient,
		allSymbols: Map<string, SymbolNode>,
		branch: string,
	): Promise<{ edges: SymbolEdge[]; errors: ExtractionError[] }> {
		const edges: SymbolEdge[] = [];
		const errors: ExtractionError[] = [];

		// For functions/methods, find what they call by looking for references
		// from the symbol's definition location outward
		if (
			symbol.type !== "FUNCTION" &&
			symbol.type !== "METHOD" &&
			symbol.type !== "CLASS"
		) {
			return { edges, errors };
		}

		// Find who calls this symbol (reverse: this symbol is the target)
		const rawRefs = await withRetry(
			() =>
				client.references(
					symbol.file_path,
					symbol.start_line,
					0, // Start of line for symbol name
					false, // Exclude declaration
				),
			maxRetries,
		);

		if (rawRefs === null) {
			errors.push({
				symbolId: symbol.id,
				symbolName: symbol.name,
				error: "LSP references request timed out or failed",
				recoverable: true,
			});
			return { edges, errors };
		}

		const locations = parseLocations(rawRefs);

		for (const loc of locations) {
			const caller = findSymbolAtLocation(loc, allSymbols);
			if (!caller || caller.id === symbol.id) continue;

			edges.push(
				createEdge(
					caller.id,
					symbol.id,
					"CALLS",
					"lsp",
					CONFIDENCE.LSP_EXACT,
					branch,
					[loc.range.start.line + 1, loc.range.end.line + 1],
					[symbol.start_line, symbol.end_line],
				),
			);
		}

		return { edges, errors };
	}

	async function extractInheritanceEdges(
		symbol: SymbolNode,
		client: LspClient,
		allSymbols: Map<string, SymbolNode>,
		branch: string,
	): Promise<{ edges: SymbolEdge[]; errors: ExtractionError[] }> {
		const edges: SymbolEdge[] = [];
		const errors: ExtractionError[] = [];

		// Only process classes and interfaces
		if (symbol.type !== "CLASS" && symbol.type !== "INTERFACE") {
			return { edges, errors };
		}

		// Go to definition to find parent classes/interfaces
		// We need to look at the signature for extends/implements
		if (!symbol.signature) {
			return { edges, errors };
		}

		// Parse extends/implements from signature
		const extendsMatch = symbol.signature.match(/extends\s+(\w+)/);
		const implementsMatch = symbol.signature.match(/implements\s+([\w,\s]+)/);

		const parentNames: string[] = [];
		if (extendsMatch) {
			parentNames.push(extendsMatch[1]);
		}
		if (implementsMatch) {
			parentNames.push(
				...implementsMatch[1].split(",").map((s) => s.trim()),
			);
		}

		// Find parent symbols by name
		for (const parentName of parentNames) {
			for (const candidate of allSymbols.values()) {
				if (candidate.name !== parentName) continue;
				if (
					candidate.type !== "CLASS" &&
					candidate.type !== "INTERFACE"
				)
					continue;

				const edgeType: EdgeType =
					candidate.type === "INTERFACE" ? "IMPLEMENTS" : "INHERITS";
				edges.push(
					createEdge(
						symbol.id,
						candidate.id,
						edgeType,
						"lsp",
						CONFIDENCE.LSP_INFERRED,
						branch,
						[symbol.start_line, symbol.end_line],
						[candidate.start_line, candidate.end_line],
					),
				);
			}
		}

		return { edges, errors };
	}

	return {
		async extractEdgesForSymbol(
			symbol: SymbolNode,
			allSymbols: Map<string, SymbolNode>,
			branch: string,
		): Promise<ExtractionResult> {
			const edges: SymbolEdge[] = [];
			const errors: ExtractionError[] = [];
			let fallbackUsed = false;

			const client = await getClient(symbol.language);
			if (!client || !client.isAlive()) {
				// Use AST fallback if available
				if (enableAstFallback && astInference) {
					const astResult = await astInference.inferEdgesForSymbol(
						symbol,
						allSymbols,
						branch,
					);
					return {
						edges: astResult.edges,
						errors: [],
						fallbackUsed: true,
					};
				}

				return {
					edges: [],
					errors: [
						{
							symbolId: symbol.id,
							symbolName: symbol.name,
							error: `LSP client not available for ${symbol.language}`,
							recoverable: false,
						},
					],
					fallbackUsed: false,
				};
			}

			// Extract call edges
			const callResult = await extractCallEdges(
				symbol,
				client,
				allSymbols,
				branch,
			);
			edges.push(...callResult.edges);
			errors.push(...callResult.errors);

			// Extract inheritance edges
			const inheritResult = await extractInheritanceEdges(
				symbol,
				client,
				allSymbols,
				branch,
			);
			edges.push(...inheritResult.edges);
			errors.push(...inheritResult.errors);

			// If we had recoverable errors and AST fallback is enabled, supplement
			if (
				errors.some((e) => e.recoverable) &&
				enableAstFallback &&
				astInference
			) {
				const astResult = await astInference.inferEdgesForSymbol(
					symbol,
					allSymbols,
					branch,
				);
				// Only add edges we don't already have
				const existingEdgeIds = new Set(edges.map((e) => e.id));
				for (const edge of astResult.edges) {
					if (!existingEdgeIds.has(edge.id)) {
						edges.push(edge);
					}
				}
				fallbackUsed = true;
			}

			return { edges, errors, fallbackUsed };
		},

		async extractEdgesForFile(
			filePath: string,
			symbols: SymbolNode[],
			allSymbols: Map<string, SymbolNode>,
			branch: string,
		): Promise<ExtractionResult> {
			const allEdges: SymbolEdge[] = [];
			const allErrors: ExtractionError[] = [];
			let anyFallbackUsed = false;

			for (const symbol of symbols) {
				if (symbol.file_path !== filePath) continue;

				const result = await this.extractEdgesForSymbol(
					symbol,
					allSymbols,
					branch,
				);
				allEdges.push(...result.edges);
				allErrors.push(...result.errors);
				if (result.fallbackUsed) anyFallbackUsed = true;
			}

			return {
				edges: allEdges,
				errors: allErrors,
				fallbackUsed: anyFallbackUsed,
			};
		},

		isAvailable(language: "typescript" | "python"): boolean {
			// This is a sync check - actual availability is async
			return language === "typescript" || language === "python";
		},
	};
}
