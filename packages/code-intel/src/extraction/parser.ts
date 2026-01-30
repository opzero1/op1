/**
 * Tree-sitter Parser Wrapper
 *
 * Provides AST parsing for TypeScript and Python using tree-sitter.
 */

import Parser, { type Language } from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";

// Language grammars
const GRAMMARS = {
	typescript: TypeScript.typescript,
	tsx: TypeScript.tsx,
	python: Python,
} as const;

type SupportedLanguage = keyof typeof GRAMMARS;

/**
 * Parser instance cache
 */
const parserCache = new Map<SupportedLanguage, Parser>();

/**
 * Get or create a parser for a language
 */
function getParser(language: SupportedLanguage): Parser {
	let parser = parserCache.get(language);
	if (!parser) {
		parser = new Parser();
		parser.setLanguage(GRAMMARS[language] as unknown as Language);
		parserCache.set(language, parser);
	}
	return parser;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
	const ext = filePath.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "ts":
			return "typescript";
		case "tsx":
			return "tsx";
		case "py":
			return "python";
		default:
			return null;
	}
}

/**
 * Parse source code and return AST
 */
export function parseCode(
	code: string,
	language: SupportedLanguage,
): Parser.Tree {
	const parser = getParser(language);
	return parser.parse(code);
}

/**
 * Parse a file and return AST with language detection
 */
export async function parseFile(
	filePath: string,
	content?: string,
): Promise<{ tree: Parser.Tree; language: SupportedLanguage } | null> {
	const language = detectLanguage(filePath);
	if (!language) {
		return null;
	}

	const code = content ?? (await Bun.file(filePath).text());
	const tree = parseCode(code, language);

	return { tree, language };
}

/**
 * Tree traversal utilities
 */
export function* walkTree(
	node: Parser.SyntaxNode,
): Generator<Parser.SyntaxNode> {
	yield node;
	for (const child of node.children) {
		yield* walkTree(child);
	}
}

/**
 * Find nodes matching a predicate
 */
export function findNodes(
	root: Parser.SyntaxNode,
	predicate: (node: Parser.SyntaxNode) => boolean,
): Parser.SyntaxNode[] {
	const results: Parser.SyntaxNode[] = [];
	for (const node of walkTree(root)) {
		if (predicate(node)) {
			results.push(node);
		}
	}
	return results;
}

/**
 * Get the text of a node from the source code
 */
export function getNodeText(node: Parser.SyntaxNode, source: string): string {
	return source.slice(node.startIndex, node.endIndex);
}

/**
 * Find the first ancestor matching a type
 */
export function findAncestor(
	node: Parser.SyntaxNode,
	type: string,
): Parser.SyntaxNode | null {
	let current = node.parent;
	while (current) {
		if (current.type === type) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

/**
 * Find child by field name
 */
export function getChildByField(
	node: Parser.SyntaxNode,
	fieldName: string,
): Parser.SyntaxNode | null {
	return node.childForFieldName(fieldName);
}

/**
 * Check if a node is within a specific line range
 */
export function isInRange(
	node: Parser.SyntaxNode,
	startLine: number,
	endLine: number,
): boolean {
	return node.startPosition.row >= startLine && node.endPosition.row <= endLine;
}

export type { SupportedLanguage };
