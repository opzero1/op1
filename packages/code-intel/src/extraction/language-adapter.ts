/**
 * Language Adapter Interface
 * 
 * Abstracts language-specific symbol extraction from AST nodes.
 */

import type { SymbolNode, SymbolType } from "../types";

/**
 * Raw symbol data extracted from AST before canonical ID assignment
 */
export interface RawSymbol {
	name: string;
	qualified_name: string;
	type: SymbolType;
	start_line: number;
	end_line: number;
	content: string;
	signature?: string;
	docstring?: string;
}

/**
 * Language adapter interface for extracting symbols from source code
 */
export interface LanguageAdapter {
	/** Language identifier */
	language: "typescript" | "python";

	/** File extensions this adapter handles */
	extensions: string[];

	/** Extract symbols from source code */
	extractSymbols(
		sourceCode: string,
		filePath: string,
	): Promise<RawSymbol[]>;

	/** Get qualified name for a symbol */
	getQualifiedName(filePath: string, symbolName: string, parentName?: string): string;
}

/**
 * Create qualified name from file path and symbol name
 */
export function createQualifiedName(
	filePath: string,
	symbolName: string,
	parentName?: string,
): string {
	// Remove extension and normalize path
	const normalized = filePath
		.replace(/\.(ts|tsx|js|jsx|py)$/, "")
		.replace(/\\/g, "/");

	if (parentName) {
		return `${normalized}.${parentName}.${symbolName}`;
	}
	return `${normalized}.${symbolName}`;
}
