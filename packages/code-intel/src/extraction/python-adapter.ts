/**
 * Python Language Adapter
 * 
 * Extracts symbols from Python files using regex-based parsing.
 */

import type { SymbolType } from "../types";
import {
	createQualifiedName,
	type LanguageAdapter,
	type RawSymbol,
} from "./language-adapter";

/**
 * Python adapter for symbol extraction
 */
export function createPythonAdapter(): LanguageAdapter {
	return {
		language: "python",
		extensions: [".py", ".pyw"],

		async extractSymbols(
			sourceCode: string,
			filePath: string,
		): Promise<RawSymbol[]> {
			const symbols: RawSymbol[] = [];
			const lines = sourceCode.split("\n");

			let currentClass: { name: string; startLine: number; indent: number } | null = null;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const lineNum = i + 1; // 1-indexed
				const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

				// Check if we've exited the current class (less or equal indentation)
				if (currentClass && indent <= currentClass.indent && line.trim()) {
					currentClass = null;
				}

				// Extract docstring (triple-quoted string after definition)
				let docstring: string | undefined;

				// Class detection
				const classMatch = line.match(/^(\s*)class\s+(\w+)(?:\s*\([^)]*\))?:/);
				if (classMatch) {
					const classIndent = classMatch[1].length;
					const name = classMatch[2];
					const endLine = findPythonBlockEnd(lines, i, classIndent);
					const content = lines.slice(i, endLine).join("\n");
					docstring = extractPythonDocstring(lines, i + 1);

					symbols.push({
						name,
						qualified_name: this.getQualifiedName(filePath, name),
						type: "CLASS",
						start_line: lineNum,
						end_line: endLine,
						content,
						signature: extractClassSignature(line),
						docstring,
					});

					currentClass = { name, startLine: lineNum, indent: classIndent };
					continue;
				}

				// Function/method detection
				const funcMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[^:]+)?:/);
				if (funcMatch) {
					const funcIndent = funcMatch[1].length;
					const name = funcMatch[2];
					const endLine = findPythonBlockEnd(lines, i, funcIndent);
					const content = lines.slice(i, endLine).join("\n");
					docstring = extractPythonDocstring(lines, i + 1);

					const isMethod = currentClass !== null && funcIndent > currentClass.indent;
					const type: SymbolType = isMethod ? "METHOD" : "FUNCTION";
					const qualifiedName = isMethod
						? this.getQualifiedName(filePath, name, currentClass!.name)
						: this.getQualifiedName(filePath, name);

					symbols.push({
						name,
						qualified_name: qualifiedName,
						type,
						start_line: lineNum,
						end_line: endLine,
						content,
						signature: extractFuncSignature(line),
						docstring,
					});
					continue;
				}

				// Module-level variable detection
				if (indent === 0 && !currentClass) {
					const varMatch = line.match(/^(\w+)\s*(?::\s*[^=]+)?\s*=/);
					if (varMatch && !line.startsWith("def ") && !line.startsWith("class ")) {
						const name = varMatch[1];
						// Skip dunder variables and private
						if (!name.startsWith("_") || name === "__all__") {
							const endLine = findStatementEnd(lines, i);
							const content = lines.slice(i, endLine).join("\n");

							symbols.push({
								name,
								qualified_name: this.getQualifiedName(filePath, name),
								type: "VARIABLE",
								start_line: lineNum,
								end_line: endLine,
								content,
							});
						}
					}
				}
			}

			return symbols;
		},

		getQualifiedName(filePath: string, symbolName: string, parentName?: string): string {
			return createQualifiedName(filePath, symbolName, parentName);
		},
	};
}

// Helper functions

function findPythonBlockEnd(lines: string[], startIndex: number, startIndent: number): number {
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue; // Skip empty lines

		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		// Block ends when we hit a line with same or less indentation
		if (indent <= startIndent && line.trim()) {
			return i;
		}
	}
	return lines.length;
}

function findStatementEnd(lines: string[], startIndex: number): number {
	// Python statements end at newline unless continued with backslash or inside brackets
	let depth = 0;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];

		// Count brackets
		for (const char of line) {
			if (char === "(" || char === "[" || char === "{") depth++;
			if (char === ")" || char === "]" || char === "}") depth--;
		}

		// Statement continues with backslash
		if (line.trimEnd().endsWith("\\")) continue;

		// Statement ends when brackets are balanced
		if (depth === 0) {
			return i + 1;
		}
	}
	return startIndex + 1;
}

function extractPythonDocstring(lines: string[], startIndex: number): string | undefined {
	if (startIndex >= lines.length) return undefined;

	const line = lines[startIndex].trim();

	// Check for triple-quoted docstring
	if (line.startsWith('"""') || line.startsWith("'''")) {
		const quote = line.slice(0, 3);

		// Single line docstring
		if (line.endsWith(quote) && line.length > 6) {
			return line.slice(3, -3);
		}

		// Multi-line docstring
		const docLines = [line.slice(3)];
		for (let i = startIndex + 1; i < lines.length; i++) {
			const docLine = lines[i];
			if (docLine.includes(quote)) {
				docLines.push(docLine.slice(0, docLine.indexOf(quote)));
				break;
			}
			docLines.push(docLine);
		}
		return docLines.join("\n").trim();
	}

	return undefined;
}

function extractClassSignature(line: string): string {
	const match = line.match(/class\s+\w+(?:\s*\([^)]*\))?/);
	return match ? match[0].trim() : "";
}

function extractFuncSignature(line: string): string {
	const match = line.match(/(?:async\s+)?def\s+\w+\s*\([^)]*\)(?:\s*->\s*[^:]+)?/);
	return match ? match[0].trim() : "";
}
