/**
 * TypeScript Language Adapter
 * 
 * Extracts symbols from TypeScript/JavaScript files using regex-based parsing.
 * This is a simpler approach that doesn't require tree-sitter bindings.
 */

import type { SymbolType } from "../types";
import {
	createQualifiedName,
	type LanguageAdapter,
	type RawSymbol,
} from "./language-adapter";

/**
 * TypeScript adapter for symbol extraction
 */
export function createTypeScriptAdapter(): LanguageAdapter {
	return {
		language: "typescript",
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],

		async extractSymbols(
			sourceCode: string,
			filePath: string,
		): Promise<RawSymbol[]> {
			const symbols: RawSymbol[] = [];
			const lines = sourceCode.split("\n");

			let currentClass: { name: string; startLine: number } | null = null;
			let braceDepth = 0;
			let classStartDepth = 0;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const lineNum = i + 1; // 1-indexed

				// Track brace depth for class scope
				const openBraces = (line.match(/{/g) || []).length;
				const closeBraces = (line.match(/}/g) || []).length;
				braceDepth += openBraces - closeBraces;

				// Check if we've exited the current class
				if (currentClass && braceDepth < classStartDepth) {
					currentClass = null;
				}

				// Extract docstring (JSDoc comment above)
				let docstring: string | undefined;
				if (i > 0) {
					const prevLines: string[] = [];
					for (let j = i - 1; j >= 0; j--) {
						const prevLine = lines[j].trim();
						if (prevLine.endsWith("*/")) {
							// Found end of JSDoc
							for (let k = j; k >= 0; k--) {
								prevLines.unshift(lines[k]);
								if (lines[k].includes("/**")) break;
							}
							break;
						}
						if (prevLine && !prevLine.startsWith("//") && !prevLine.startsWith("*")) {
							break;
						}
					}
					if (prevLines.length > 0) {
						docstring = prevLines.join("\n").trim();
					}
				}

				// Class detection
				const classMatch = line.match(
					/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/,
				);
				if (classMatch) {
					const name = classMatch[1];
					const endLine = findBlockEnd(lines, i);
					const content = lines.slice(i, endLine).join("\n");

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

					currentClass = { name, startLine: lineNum };
					classStartDepth = braceDepth;
					continue;
				}

				// Interface detection
				const interfaceMatch = line.match(
					/^(?:export\s+)?interface\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+[\w,\s<>]+)?/,
				);
				if (interfaceMatch) {
					const name = interfaceMatch[1];
					const endLine = findBlockEnd(lines, i);
					const content = lines.slice(i, endLine).join("\n");

					symbols.push({
						name,
						qualified_name: this.getQualifiedName(filePath, name),
						type: "INTERFACE",
						start_line: lineNum,
						end_line: endLine,
						content,
						signature: extractInterfaceSignature(line),
						docstring,
					});
					continue;
				}

				// Type alias detection
				const typeMatch = line.match(/^(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=/);
				if (typeMatch) {
					const name = typeMatch[1];
					const endLine = findTypeEnd(lines, i);
					const content = lines.slice(i, endLine).join("\n");

					symbols.push({
						name,
						qualified_name: this.getQualifiedName(filePath, name),
						type: "TYPE_ALIAS",
						start_line: lineNum,
						end_line: endLine,
						content,
						docstring,
					});
					continue;
				}

				// Enum detection
				const enumMatch = line.match(/^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/);
				if (enumMatch) {
					const name = enumMatch[1];
					const endLine = findBlockEnd(lines, i);
					const content = lines.slice(i, endLine).join("\n");

					symbols.push({
						name,
						qualified_name: this.getQualifiedName(filePath, name),
						type: "ENUM",
						start_line: lineNum,
						end_line: endLine,
						content,
						docstring,
					});
					continue;
				}

				// Function detection (standalone)
				const functionMatch = line.match(
					/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(/,
				);
				if (functionMatch && !currentClass) {
					const name = functionMatch[1];
					const endLine = findBlockEnd(lines, i);
					const content = lines.slice(i, endLine).join("\n");

					symbols.push({
						name,
						qualified_name: this.getQualifiedName(filePath, name),
						type: "FUNCTION",
						start_line: lineNum,
						end_line: endLine,
						content,
						signature: extractFunctionSignature(lines, i),
						docstring,
					});
					continue;
				}

				// Arrow function / const function detection
				const arrowMatch = line.match(
					/^(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\(/,
				);
				const arrowMatch2 = line.match(
					/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/,
				);
				if ((arrowMatch || arrowMatch2) && !currentClass) {
					const name = (arrowMatch || arrowMatch2)![1];
					const endLine = findArrowEnd(lines, i);
					const content = lines.slice(i, endLine).join("\n");

					symbols.push({
						name,
						qualified_name: this.getQualifiedName(filePath, name),
						type: "FUNCTION",
						start_line: lineNum,
						end_line: endLine,
						content,
						signature: extractArrowSignature(lines, i),
						docstring,
					});
					continue;
				}

				// Method detection (inside class)
				if (currentClass) {
					const methodMatch = line.match(
						/^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*(?:<[^>]+>)?\s*\(/,
					);
					if (methodMatch && !line.includes("constructor")) {
						const name = methodMatch[1];
						if (name !== "if" && name !== "for" && name !== "while" && name !== "switch") {
							const endLine = findBlockEnd(lines, i);
							const content = lines.slice(i, endLine).join("\n");

							symbols.push({
								name,
								qualified_name: this.getQualifiedName(filePath, name, currentClass.name),
								type: "METHOD",
								start_line: lineNum,
								end_line: endLine,
								content,
								signature: extractMethodSignature(lines, i),
								docstring,
							});
						}
					}
				}

				// Variable/constant detection (module level)
				if (!currentClass && braceDepth === 0) {
					const varMatch = line.match(
						/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/,
					);
					if (varMatch && !arrowMatch && !arrowMatch2) {
						const name = varMatch[1];
						// Check if it's not a function
						if (!line.includes("=>") && !line.includes("function")) {
							const endLine = findStatementEnd(lines, i);
							const content = lines.slice(i, endLine).join("\n");

							symbols.push({
								name,
								qualified_name: this.getQualifiedName(filePath, name),
								type: "VARIABLE",
								start_line: lineNum,
								end_line: endLine,
								content,
								docstring,
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

// Helper functions for finding block/statement ends

function findBlockEnd(lines: string[], startIndex: number): number {
	let braceDepth = 0;
	let started = false;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		for (const char of line) {
			if (char === "{") {
				braceDepth++;
				started = true;
			} else if (char === "}") {
				braceDepth--;
				if (started && braceDepth === 0) {
					return i + 1; // 1-indexed end line
				}
			}
		}
	}
	return lines.length;
}

function findTypeEnd(lines: string[], startIndex: number): number {
	let depth = 0;
	let started = false;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];

		// Count brackets/braces
		for (const char of line) {
			if (char === "{" || char === "<" || char === "(") {
				depth++;
				started = true;
			} else if (char === "}" || char === ">" || char === ")") {
				depth--;
			}
		}

		// Type ends with semicolon at depth 0
		if (line.includes(";") && depth === 0 && (started || i === startIndex)) {
			return i + 1;
		}
	}
	return startIndex + 1;
}

function findArrowEnd(lines: string[], startIndex: number): number {
	// Arrow functions can be single line or multi-line
	const firstLine = lines[startIndex];

	// Single line arrow function
	if (!firstLine.includes("{") && firstLine.includes("=>")) {
		return startIndex + 1;
	}

	// Multi-line - find block end
	return findBlockEnd(lines, startIndex);
}

function findStatementEnd(lines: string[], startIndex: number): number {
	for (let i = startIndex; i < lines.length; i++) {
		if (lines[i].includes(";")) {
			return i + 1;
		}
	}
	return startIndex + 1;
}

// Signature extraction helpers

function extractClassSignature(line: string): string {
	const match = line.match(/class\s+\w+[^{]*/);
	return match ? match[0].trim() : "";
}

function extractInterfaceSignature(line: string): string {
	const match = line.match(/interface\s+\w+[^{]*/);
	return match ? match[0].trim() : "";
}

function extractFunctionSignature(lines: string[], startIndex: number): string {
	let sig = "";
	let parenDepth = 0;
	let started = false;

	for (let i = startIndex; i < Math.min(startIndex + 10, lines.length); i++) {
		const line = lines[i];
		for (const char of line) {
			sig += char;
			if (char === "(") {
				parenDepth++;
				started = true;
			} else if (char === ")") {
				parenDepth--;
				if (started && parenDepth === 0) {
					// Include return type if present
					const rest = line.slice(line.indexOf(")") + 1);
					const returnMatch = rest.match(/^\s*:\s*[^{]+/);
					if (returnMatch) {
						sig += returnMatch[0];
					}
					return sig.trim();
				}
			}
		}
		if (started && parenDepth === 0) break;
		sig += "\n";
	}
	return sig.trim();
}

function extractMethodSignature(lines: string[], startIndex: number): string {
	return extractFunctionSignature(lines, startIndex);
}

function extractArrowSignature(lines: string[], startIndex: number): string {
	const line = lines[startIndex];
	const match = line.match(/(?:const|let)\s+\w+\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\([^)]*\)(?:\s*:\s*[^=]+)?(?:\s*=>)?/);
	return match ? match[0].trim() : "";
}
