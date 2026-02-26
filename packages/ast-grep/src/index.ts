/**
 * @op1/ast-grep
 *
 * AST-aware code search and replace tools for OpenCode.
 * Powered by ast-grep (https://ast-grep.github.io/).
 *
 * Features:
 * - 25 language support (TypeScript, Python, Go, Rust, etc.)
 * - Meta-variables for pattern matching ($VAR, $$$)
 * - Auto-download of ast-grep binary if not installed
 * - Timeout and output limits for safety
 *
 * Usage:
 * ```json
 * // opencode.json
 * {
 *   "plugin": ["@op1/ast-grep"]
 * }
 * ```
 *
 * IMPORTANT: OpenCode's plugin loader calls ALL exports as functions.
 * Only the plugin function should be exported from the main entry point.
 * For programmatic access to tools/utilities, import from "@op1/ast-grep/tools".
 */

import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";
import { startBackgroundInit } from "./cli";
import { setAstGrepLogger } from "./downloader";
import { ast_grep_replace, ast_grep_search } from "./tools";

const builtinTools: Record<string, ToolDefinition> = {
	ast_grep_search,
	ast_grep_replace,
};

/**
 * AST-Grep Plugin for OpenCode
 *
 * Provides ast_grep_search and ast_grep_replace tools.
 */
const AstGrepPlugin: Plugin = async (ctx) => {
	setAstGrepLogger(async ({ level, message, extra }) => {
		try {
			await ctx.client.app.log({
				body: {
					service: "op1.ast-grep",
					level,
					message,
					extra,
				},
			});
		} catch {
			// Ignore logging failures to keep plugin initialization resilient.
		}
	});

	// Start background initialization of ast-grep binary
	startBackgroundInit();

	return {
		tool: builtinTools,
	};
};

// ONLY export the plugin function - OpenCode calls all exports as functions
export default AstGrepPlugin;
