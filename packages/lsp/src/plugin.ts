/**
 * LSP Plugin Export
 *
 * Main plugin entry point for OpenCode integration.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { runtimePlatform } from "./bun-utils";
import { lspManager } from "./client";
import {
	lsp_diagnostics,
	lsp_find_references,
	lsp_goto_definition,
	lsp_prepare_rename,
	lsp_rename,
	lsp_symbols,
} from "./tools";

/**
 * LSP Plugin for OpenCode
 *
 * Provides 6 LSP tools for code navigation and refactoring:
 * - lsp_goto_definition
 * - lsp_find_references
 * - lsp_symbols
 * - lsp_diagnostics
 * - lsp_prepare_rename
 * - lsp_rename
 */
export const LspPlugin: Plugin = async (_ctx) => {
	// Register cleanup on process exit
	const cleanup = () => {
		lspManager.stopAll();
	};

	addEventListener("SIGINT", cleanup);
	addEventListener("SIGTERM", cleanup);
	if (runtimePlatform() === "win32") {
		addEventListener("SIGBREAK", cleanup);
	}

	return {
		name: "@op1/lsp",
		tool: {
			lsp_goto_definition,
			lsp_find_references,
			lsp_symbols,
			lsp_diagnostics,
			lsp_prepare_rename,
			lsp_rename,
		},
	};
};

export default LspPlugin;
