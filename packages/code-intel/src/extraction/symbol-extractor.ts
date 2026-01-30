/**
 * Symbol Extractor
 * 
 * Coordinates language adapters to extract symbols from source files.
 */

import type { SymbolNode } from "../types";
import {
	generateCanonicalId,
	generateContentHash,
} from "./canonical-id";
import type { LanguageAdapter, RawSymbol } from "./language-adapter";
import { createTypeScriptAdapter } from "./typescript-adapter";
import { createPythonAdapter } from "./python-adapter";

export interface SymbolExtractor {
	/** Extract symbols from a file */
	extractFromFile(
		filePath: string,
		content: string,
		branch: string,
		isExternal?: boolean,
	): Promise<SymbolNode[]>;

	/** Check if a file is supported */
	isSupported(filePath: string): boolean;

	/** Get language for a file path */
	getLanguage(filePath: string): "typescript" | "python" | null;
}

export function createSymbolExtractor(): SymbolExtractor {
	const adapters: LanguageAdapter[] = [
		createTypeScriptAdapter(),
		createPythonAdapter(),
	];

	// Build extension to adapter map
	const extensionMap = new Map<string, LanguageAdapter>();
	for (const adapter of adapters) {
		for (const ext of adapter.extensions) {
			extensionMap.set(ext, adapter);
		}
	}

	function getAdapter(filePath: string): LanguageAdapter | null {
		const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
		if (!ext) return null;
		return extensionMap.get(ext) ?? null;
	}

	return {
		async extractFromFile(
			filePath: string,
			content: string,
			branch: string,
			isExternal = false,
		): Promise<SymbolNode[]> {
			const adapter = getAdapter(filePath);
			if (!adapter) return [];

			try {
				const rawSymbols = await adapter.extractSymbols(content, filePath);
				const now = Date.now();

				return rawSymbols.map((raw: RawSymbol): SymbolNode => {
					const id = generateCanonicalId(
						raw.qualified_name,
						raw.signature,
						adapter.language,
					);

					return {
						id,
						name: raw.name,
						qualified_name: raw.qualified_name,
						type: raw.type,
						language: adapter.language,
						file_path: filePath,
						start_line: raw.start_line,
						end_line: raw.end_line,
						content: isExternal ? "" : raw.content, // Don't store content for external
						signature: raw.signature,
						docstring: raw.docstring,
						content_hash: generateContentHash(raw.content),
						is_external: isExternal,
						branch,
						updated_at: now,
						revision_id: 0,
					};
				});
			} catch (error) {
				console.error(`[code-intel] Error extracting symbols from ${filePath}:`, error);
				return [];
			}
		},

		isSupported(filePath: string): boolean {
			return getAdapter(filePath) !== null;
		},

		getLanguage(filePath: string): "typescript" | "python" | null {
			const adapter = getAdapter(filePath);
			return adapter?.language ?? null;
		},
	};
}
