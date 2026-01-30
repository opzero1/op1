/**
 * AST-based Edge Inference
 *
 * Fallback extraction when LSP is unavailable or fails.
 * Extracts import statements and infers call relationships from function references.
 * Lower confidence (0.3-0.5) for inferred edges.
 */

import type { EdgeType, SymbolEdge, SymbolNode } from "../types";
import { generateEdgeId } from "./canonical-id";

// ============================================================================
// Types
// ============================================================================

export interface AstInferenceConfig {
	/** Minimum confidence threshold for emitting edges (default: 0.3) */
	minConfidence: number;
}

export interface InferenceResult {
	edges: SymbolEdge[];
	/** Number of potential edges skipped due to low confidence */
	skippedCount: number;
}

export interface ImportInfo {
	/** Module path or package name */
	modulePath: string;
	/** Imported symbol names */
	imports: Array<{
		name: string;
		alias?: string;
		isDefault?: boolean;
		isNamespace?: boolean;
	}>;
	/** Line number of import statement */
	line: number;
}

export interface CallReference {
	/** Name of the called function/method */
	name: string;
	/** Line number where call occurs */
	line: number;
	/** Whether it's a method call (obj.method()) */
	isMethodCall: boolean;
	/** Object name for method calls */
	objectName?: string;
}

export interface AstInference {
	/** Infer edges for a single symbol */
	inferEdgesForSymbol(
		symbol: SymbolNode,
		allSymbols: Map<string, SymbolNode>,
		branch: string,
	): Promise<InferenceResult>;

	/** Infer import edges from file content */
	inferImportEdges(
		filePath: string,
		content: string,
		allSymbols: Map<string, SymbolNode>,
		branch: string,
	): InferenceResult;

	/** Parse imports from source code */
	parseImports(content: string, language: "typescript" | "python"): ImportInfo[];

	/** Find function/method call references in content */
	findCallReferences(
		content: string,
		language: "typescript" | "python",
	): CallReference[];
}

// ============================================================================
// Confidence Scores
// ============================================================================

const CONFIDENCE = {
	/** Import statement clearly maps to a symbol */
	IMPORT_EXACT: 0.5,
	/** Import inferred from module name matching */
	IMPORT_INFERRED: 0.35,
	/** Call reference with exact name match */
	CALL_EXACT: 0.45,
	/** Call reference with fuzzy match */
	CALL_INFERRED: 0.3,
} as const;

// ============================================================================
// Regex Patterns
// ============================================================================

const TS_PATTERNS = {
	// import { foo, bar } from 'module'
	NAMED_IMPORT:
		/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
	// import foo from 'module'
	DEFAULT_IMPORT:
		/import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g,
	// import * as foo from 'module'
	NAMESPACE_IMPORT:
		/import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g,
	// import 'module' (side-effect)
	SIDE_EFFECT_IMPORT: /import\s*['"]([^'"]+)['"]/g,
	// export { foo } from 'module'
	REEXPORT:
		/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
	// Function call: functionName(
	FUNCTION_CALL: /\b([a-zA-Z_$][\w$]*)\s*\(/g,
	// Method call: object.method(
	METHOD_CALL: /\b([a-zA-Z_$][\w$]*)\s*\.\s*([a-zA-Z_$][\w$]*)\s*\(/g,
};

const PY_PATTERNS = {
	// from module import foo, bar
	FROM_IMPORT:
		/from\s+([\w.]+)\s+import\s+(.+)/g,
	// import module
	IMPORT_MODULE: /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm,
	// Function call: function_name(
	FUNCTION_CALL: /\b([a-zA-Z_][\w]*)\s*\(/g,
	// Method call: object.method(
	METHOD_CALL: /\b([a-zA-Z_][\w]*)\s*\.\s*([a-zA-Z_][\w]*)\s*\(/g,
};

// ============================================================================
// Implementation
// ============================================================================

export function createAstInference(
	config: AstInferenceConfig = { minConfidence: 0.3 },
): AstInference {
	const { minConfidence } = config;

	function createEdge(
		sourceId: string,
		targetId: string,
		type: EdgeType,
		confidence: number,
		branch: string,
		sourceRange?: [number, number],
	): SymbolEdge {
		return {
			id: generateEdgeId(sourceId, targetId, type),
			source_id: sourceId,
			target_id: targetId,
			type,
			confidence,
			origin: "ast-inference",
			branch,
			source_range: sourceRange,
			updated_at: Date.now(),
		};
	}

	function parseTypeScriptImports(content: string): ImportInfo[] {
		const imports: ImportInfo[] = [];
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Named imports
			const namedMatch = line.match(
				/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/,
			);
			if (namedMatch) {
				const names = namedMatch[1].split(",").map((s) => {
					const parts = s.trim().split(/\s+as\s+/);
					return {
						name: parts[0].trim(),
						alias: parts[1]?.trim(),
					};
				});
				imports.push({
					modulePath: namedMatch[2],
					imports: names,
					line: lineNum,
				});
				continue;
			}

			// Default import
			const defaultMatch = line.match(
				/import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/,
			);
			if (defaultMatch) {
				imports.push({
					modulePath: defaultMatch[2],
					imports: [{ name: defaultMatch[1], isDefault: true }],
					line: lineNum,
				});
				continue;
			}

			// Namespace import
			const nsMatch = line.match(
				/import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/,
			);
			if (nsMatch) {
				imports.push({
					modulePath: nsMatch[2],
					imports: [{ name: nsMatch[1], isNamespace: true }],
					line: lineNum,
				});
			}
		}

		return imports;
	}

	function parsePythonImports(content: string): ImportInfo[] {
		const imports: ImportInfo[] = [];
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// from module import ...
			const fromMatch = line.match(/from\s+([\w.]+)\s+import\s+(.+)/);
			if (fromMatch) {
				const importsPart = fromMatch[2];
				const names = importsPart.split(",").map((s) => {
					const parts = s.trim().split(/\s+as\s+/);
					return {
						name: parts[0].trim(),
						alias: parts[1]?.trim(),
					};
				});
				imports.push({
					modulePath: fromMatch[1],
					imports: names,
					line: lineNum,
				});
				continue;
			}

			// import module
			const importMatch = line.match(
				/^import\s+([\w.]+)(?:\s+as\s+(\w+))?/,
			);
			if (importMatch) {
				imports.push({
					modulePath: importMatch[1],
					imports: [
						{
							name: importMatch[1].split(".").pop() || importMatch[1],
							alias: importMatch[2],
							isNamespace: true,
						},
					],
					line: lineNum,
				});
			}
		}

		return imports;
	}

	function findTypeScriptCalls(content: string): CallReference[] {
		const calls: CallReference[] = [];
		const lines = content.split("\n");

		// Track which names are function definitions to avoid counting them as calls
		const functionDefs = new Set<string>();
		const funcDefPattern = /(?:function|const|let|var)\s+(\w+)\s*[=:]/g;
		let match: RegExpExecArray | null;
		while ((match = funcDefPattern.exec(content)) !== null) {
			functionDefs.add(match[1]);
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Skip import/export lines
			if (/^\s*(import|export)\s/.test(line)) continue;
			// Skip function definitions
			if (/^\s*(function|async\s+function|const|let|var)\s+\w+\s*[=(]/.test(line)) continue;

			// Method calls
			const methodPattern = /\b([a-zA-Z_$][\w$]*)\s*\.\s*([a-zA-Z_$][\w$]*)\s*\(/g;
			let methodMatch: RegExpExecArray | null;
			while ((methodMatch = methodPattern.exec(line)) !== null) {
				calls.push({
					name: methodMatch[2],
					line: lineNum,
					isMethodCall: true,
					objectName: methodMatch[1],
				});
			}

			// Standalone function calls
			const funcPattern = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
			let funcMatch: RegExpExecArray | null;
			while ((funcMatch = funcPattern.exec(line)) !== null) {
				const name = funcMatch[1];
				// Skip keywords and common builtins
				if (
					[
						"if",
						"for",
						"while",
						"switch",
						"catch",
						"function",
						"return",
						"typeof",
						"new",
						"await",
						"async",
					].includes(name)
				) {
					continue;
				}
				// Skip if it's a method call (already captured)
				if (line.slice(0, funcMatch.index).match(/\.\s*$/)) continue;

				calls.push({
					name,
					line: lineNum,
					isMethodCall: false,
				});
			}
		}

		return calls;
	}

	function findPythonCalls(content: string): CallReference[] {
		const calls: CallReference[] = [];
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Skip import/def/class lines
			if (/^\s*(import|from|def|class)\s/.test(line)) continue;

			// Method calls
			const methodPattern = /\b([a-zA-Z_][\w]*)\s*\.\s*([a-zA-Z_][\w]*)\s*\(/g;
			let methodMatch: RegExpExecArray | null;
			while ((methodMatch = methodPattern.exec(line)) !== null) {
				calls.push({
					name: methodMatch[2],
					line: lineNum,
					isMethodCall: true,
					objectName: methodMatch[1],
				});
			}

			// Standalone function calls
			const funcPattern = /\b([a-zA-Z_][\w]*)\s*\(/g;
			let funcMatch: RegExpExecArray | null;
			while ((funcMatch = funcPattern.exec(line)) !== null) {
				const name = funcMatch[1];
				// Skip keywords
				if (
					["if", "for", "while", "with", "except", "lambda", "print"].includes(
						name,
					)
				) {
					continue;
				}
				// Skip if it's a method call
				if (line.slice(0, funcMatch.index).match(/\.\s*$/)) continue;

				calls.push({
					name,
					line: lineNum,
					isMethodCall: false,
				});
			}
		}

		return calls;
	}

	function findSymbolByName(
		name: string,
		allSymbols: Map<string, SymbolNode>,
		preferredPath?: string,
	): SymbolNode | null {
		let bestMatch: SymbolNode | null = null;
		let bestScore = 0;

		for (const symbol of allSymbols.values()) {
			if (symbol.name !== name) continue;

			let score = 1;
			// Prefer symbols from the same file
			if (preferredPath && symbol.file_path === preferredPath) {
				score += 2;
			}
			// Prefer functions/methods/classes over variables
			if (["FUNCTION", "METHOD", "CLASS"].includes(symbol.type)) {
				score += 1;
			}

			if (score > bestScore) {
				bestScore = score;
				bestMatch = symbol;
			}
		}

		return bestMatch;
	}

	function resolveModuleToFile(
		modulePath: string,
		fromFile: string,
		allSymbols: Map<string, SymbolNode>,
	): string | null {
		// Try to find a file that matches the module path
		const normalizedModule = modulePath
			.replace(/^\.\//, "")
			.replace(/\.\.\//g, "")
			.replace(/\//g, "/");

		for (const symbol of allSymbols.values()) {
			if (symbol.file_path.includes(normalizedModule)) {
				return symbol.file_path;
			}
		}

		return null;
	}

	return {
		async inferEdgesForSymbol(
			symbol: SymbolNode,
			allSymbols: Map<string, SymbolNode>,
			branch: string,
		): Promise<InferenceResult> {
			const edges: SymbolEdge[] = [];
			let skippedCount = 0;

			// Skip external symbols
			if (symbol.is_external || !symbol.content) {
				return { edges, skippedCount };
			}

			// Find call references within this symbol's content
			const calls =
				symbol.language === "typescript"
					? findTypeScriptCalls(symbol.content)
					: findPythonCalls(symbol.content);

			for (const call of calls) {
				const target = findSymbolByName(
					call.name,
					allSymbols,
					symbol.file_path,
				);
				if (!target || target.id === symbol.id) continue;

				const confidence = call.isMethodCall
					? CONFIDENCE.CALL_INFERRED
					: CONFIDENCE.CALL_EXACT;

				if (confidence < minConfidence) {
					skippedCount++;
					continue;
				}

				edges.push(
					createEdge(
						symbol.id,
						target.id,
						"CALLS",
						confidence,
						branch,
						[symbol.start_line + call.line - 1, symbol.start_line + call.line - 1],
					),
				);
			}

			return { edges, skippedCount };
		},

		inferImportEdges(
			filePath: string,
			content: string,
			allSymbols: Map<string, SymbolNode>,
			branch: string,
		): InferenceResult {
			const edges: SymbolEdge[] = [];
			let skippedCount = 0;

			// Detect language from file extension
			const isTypeScript = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
			const isPython = /\.py$/.test(filePath);

			if (!isTypeScript && !isPython) {
				return { edges, skippedCount };
			}

			const imports = isTypeScript
				? parseTypeScriptImports(content)
				: parsePythonImports(content);

			// Find the source symbol (MODULE type for the file)
			let sourceSymbol: SymbolNode | null = null;
			for (const sym of allSymbols.values()) {
				if (sym.file_path === filePath && sym.type === "MODULE") {
					sourceSymbol = sym;
					break;
				}
			}

			// If no module symbol, use the first symbol from this file
			if (!sourceSymbol) {
				for (const sym of allSymbols.values()) {
					if (sym.file_path === filePath) {
						sourceSymbol = sym;
						break;
					}
				}
			}

			if (!sourceSymbol) {
				return { edges, skippedCount };
			}

			for (const importInfo of imports) {
				// Try to resolve the module to a file
				const targetFile = resolveModuleToFile(
					importInfo.modulePath,
					filePath,
					allSymbols,
				);

				for (const imp of importInfo.imports) {
					// Find the imported symbol
					const target = findSymbolByName(
						imp.name,
						allSymbols,
						targetFile ?? undefined,
					);

					if (!target) {
						skippedCount++;
						continue;
					}

					const confidence = targetFile
						? CONFIDENCE.IMPORT_EXACT
						: CONFIDENCE.IMPORT_INFERRED;

					if (confidence < minConfidence) {
						skippedCount++;
						continue;
					}

					edges.push(
						createEdge(
							sourceSymbol.id,
							target.id,
							"IMPORTS",
							confidence,
							branch,
							[importInfo.line, importInfo.line],
						),
					);
				}
			}

			return { edges, skippedCount };
		},

		parseImports(
			content: string,
			language: "typescript" | "python",
		): ImportInfo[] {
			return language === "typescript"
				? parseTypeScriptImports(content)
				: parsePythonImports(content);
		},

		findCallReferences(
			content: string,
			language: "typescript" | "python",
		): CallReference[] {
			return language === "typescript"
				? findTypeScriptCalls(content)
				: findPythonCalls(content);
		},
	};
}
