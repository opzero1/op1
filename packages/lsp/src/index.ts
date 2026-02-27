/**
 * @op1/lsp - LSP Integration Plugin for OpenCode
 *
 * Language Server Protocol tools for code navigation and refactoring.
 * Ported from oh-my-opencode with Bun-native APIs.
 *
 * Tools provided:
 * - lsp_goto_definition: Jump to symbol definition
 * - lsp_find_references: Find all references to a symbol
 * - lsp_symbols: Document/workspace symbol search
 * - lsp_diagnostics: Get errors/warnings from language server
 * - lsp_prepare_rename: Check if rename is valid
 * - lsp_rename: Rename symbol across files
 */

// Export plugin (default export for OpenCode plugin loader)
export { default, LspPlugin } from "./plugin";

// Re-export types only (no classes)
export type {
	Diagnostic,
	Location,
	LSPServerConfig,
	Position,
	Range,
	SymbolInfo,
} from "./types";
