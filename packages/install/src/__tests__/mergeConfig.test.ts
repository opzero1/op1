/**
 * Unit tests for mergeConfig function
 * Tests the complex config merging logic that preserves user settings
 */

import { describe, test, expect } from "bun:test";
import { mergeConfig, type OpenCodeConfig, type McpDefinition, type PluginChoice } from "../index";

// Helper to create a basic MCP definition for testing
function createMockMcp(id: string, toolPattern: string, agentAccess: string[]): McpDefinition {
	return {
		id,
		name: `${id} MCP`,
		description: `Test ${id}`,
		config: { type: "remote", url: `https://example.com/${id}` },
		toolPattern,
		agentAccess,
	};
}

// Default plugin choices for testing
const DEFAULT_PLUGIN_CHOICES: PluginChoice = {
	notify: false,
	workspace: false,
	codeIntel: false,
	astGrep: false,
	lsp: false,
	semanticSearch: false,
	codeGraph: false,
};

const ENABLED_PLUGIN_CHOICES: PluginChoice = {
	notify: true,
	workspace: true,
	codeIntel: false,
	astGrep: false,
	lsp: false,
	semanticSearch: false,
	codeGraph: false,
};

describe("mergeConfig", () => {
	const allAgents = ["build", "coder", "explore", "frontend", "oracle", "plan", "researcher", "reviewer", "scribe"];

	test("creates fresh config when existing is null", () => {
		const result = mergeConfig(
			null,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result).toHaveProperty("$schema", "https://opencode.ai/config.json");
		expect(result).toHaveProperty("agent");
		// All agents should be present in config
		for (const agent of allAgents) {
			expect(result.agent?.[agent]).toBeDefined();
		}
	});

	test("preserves provider from original config", () => {
		const originalConfig: OpenCodeConfig = {
			provider: {
				openrouter: { api_key: "sk-test-123" },
			},
		};

		const result = mergeConfig(
			null, // existing is null (backup-replace scenario)
			originalConfig,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.provider).toEqual(originalConfig.provider);
	});

	test("preserves existing model settings", () => {
		const existing: OpenCodeConfig = {
			model: "anthropic/claude-opus-4",
			small_model: "anthropic/claude-haiku-3",
			default_agent: "oracle",
		};

		const result = mergeConfig(
			existing,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.model).toBe("anthropic/claude-opus-4");
		expect(result.small_model).toBe("anthropic/claude-haiku-3");
		expect(result.default_agent).toBe("oracle");
	});

	test("adds new plugins without removing existing ones", () => {
		const existing: OpenCodeConfig = {
			plugin: ["@existing/plugin"],
		};

		const result = mergeConfig(
			existing,
			null,
			[],
			ENABLED_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.plugin).toEqual([
			"@existing/plugin",
			"@op1/notify",
			"@op1/workspace",
		]);
	});

	test("does not duplicate plugins if already present", () => {
		const existing: OpenCodeConfig = {
			plugin: ["@op1/notify"],
		};

		const result = mergeConfig(
			existing,
			null,
			[],
			ENABLED_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.plugin).toEqual([
			"@op1/notify",
			"@op1/workspace",
		]);
	});

	test("merges MCPs without overwriting existing ones", () => {
		const existing: OpenCodeConfig = {
			mcp: {
				"existing-mcp": { type: "local", command: ["test"] },
			},
		};

		const newMcps = [createMockMcp("new-mcp", "new_*", ["coder"])];

		const result = mergeConfig(
			existing,
			null,
			newMcps,
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.mcp).toHaveProperty("existing-mcp");
		expect(result.mcp).toHaveProperty("new-mcp");
		expect(result.mcp?.["existing-mcp"]).toEqual({ type: "local", command: ["test"] });
	});

	test("configures tool visibility (disabled by default)", () => {
		const newMcps = [
			createMockMcp("linear", "linear_*", ["researcher"]),
			createMockMcp("notion", "notion_*", ["researcher"]),
		];

		const result = mergeConfig(
			null,
			null,
			newMcps,
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.tools?.["linear_*"]).toBe(false);
		expect(result.tools?.["notion_*"]).toBe(false);
	});

	test("enables tools for specific agents", () => {
		const newMcps = [
			createMockMcp("linear", "linear_*", ["researcher", "oracle"]),
		];

		const result = mergeConfig(
			null,
			null,
			newMcps,
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		// Tool should be disabled globally
		expect(result.tools?.["linear_*"]).toBe(false);
		
		// But enabled for researcher and oracle agents
		expect(result.agent?.researcher?.tools?.["linear_*"]).toBe(true);
		expect(result.agent?.oracle?.tools?.["linear_*"]).toBe(true);
		
		// Not enabled for coder
		expect(result.agent?.coder?.tools?.["linear_*"]).toBeUndefined();
	});

	test("preserves existing agent tool configurations", () => {
		const existing: OpenCodeConfig = {
			agent: {
				coder: {
					tools: {
						"existing_*": true,
					},
				},
			},
		};

		const newMcps = [createMockMcp("new", "new_*", ["coder"])];

		const result = mergeConfig(
			existing,
			null,
			newMcps,
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.agent?.coder?.tools?.["existing_*"]).toBe(true);
		expect(result.agent?.coder?.tools?.["new_*"]).toBe(true);
	});

	test("sets global model when provided", () => {
		const result = mergeConfig(
			null,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			"anthropic/claude-sonnet-4-20250514",
			allAgents
		);

		expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
	});

	test("does not override existing global model", () => {
		const existing: OpenCodeConfig = {
			model: "existing-model",
		};

		const result = mergeConfig(
			existing,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			"new-model",
			allAgents
		);

		expect(result.model).toBe("existing-model");
	});

	test("sets per-agent models", () => {
		const agentModels = {
			oracle: "quotio/gpt-5.2-codex",
			coder: "proxy/claude-opus-4-5-thinking",
		};

		const result = mergeConfig(
			null,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			agentModels,
			null,
			allAgents
		);

		expect(result.agent?.oracle?.model).toBe("quotio/gpt-5.2-codex");
		expect(result.agent?.coder?.model).toBe("proxy/claude-opus-4-5-thinking");
	});

	test("does not override existing agent models", () => {
		const existing: OpenCodeConfig = {
			agent: {
				oracle: {
					model: "existing-oracle-model",
				},
			},
		};

		const agentModels = {
			oracle: "new-oracle-model",
			coder: "new-coder-model",
		};

		const result = mergeConfig(
			existing,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			agentModels,
			null,
			allAgents
		);

		expect(result.agent?.oracle?.model).toBe("existing-oracle-model");
		expect(result.agent?.coder?.model).toBe("new-coder-model");
	});

	test("sets default compaction config when not present", () => {
		const result = mergeConfig(
			null,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.compaction).toEqual({ auto: true, prune: true });
	});

	test("preserves existing compaction config", () => {
		const existing: OpenCodeConfig = {
			compaction: { auto: false, prune: false },
		};

		const result = mergeConfig(
			existing,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.compaction).toEqual({ auto: false, prune: false });
	});

	test("preserves permissions from original config", () => {
		const originalConfig: OpenCodeConfig = {
			permission: {
				bash: "approved",
				edit: "approved",
			},
		};

		const result = mergeConfig(
			null,
			originalConfig,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		expect(result.permission).toEqual({
			bash: "approved",
			edit: "approved",
		});
	});

	test("ensures all agents are present in config", () => {
		const result = mergeConfig(
			null,
			null,
			[],
			DEFAULT_PLUGIN_CHOICES,
			{},
			null,
			allAgents
		);

		for (const agentName of allAgents) {
			expect(result.agent?.[agentName]).toBeDefined();
			expect(result.agent?.[agentName]).toBeTypeOf("object");
		}
	});

	test("complex merge scenario: preserves provider during backup-replace", () => {
		// Scenario: User has malformed config, chooses backup-replace
		// existing is null, but originalConfig has provider
		const originalConfig: OpenCodeConfig = {
			provider: {
				anthropic: { api_key: "sk-ant-123" },
			},
			model: "anthropic/claude-opus-4",
			plugin: ["@old/plugin"],
		};

		const newMcps = [createMockMcp("linear", "linear_*", ["researcher"])];

		const result = mergeConfig(
			null, // existing is null (backup-replace)
			originalConfig, // but we pass original to preserve provider
			newMcps,
			ENABLED_PLUGIN_CHOICES,
			{ oracle: "quotio/gpt-5.2-codex" },
			null,
			allAgents
		);

		// Provider should be preserved
		expect(result.provider).toEqual(originalConfig.provider);
		
		// But plugins should be from new config (plus op1 plugins)
		expect(result.plugin).toEqual(["@old/plugin", "@op1/notify", "@op1/workspace"]);
		
		// Model should be preserved
		expect(result.model).toBe("anthropic/claude-opus-4");
		
		// New MCPs should be added
		expect(result.mcp).toHaveProperty("linear");
		
		// Agent models should be set
		expect(result.agent?.oracle?.model).toBe("quotio/gpt-5.2-codex");
	});

	test("complex merge scenario: merge with existing valid config", () => {
		const existing: OpenCodeConfig = {
			$schema: "https://opencode.ai/config.json",
			provider: {
				openrouter: { api_key: "sk-or-123" },
			},
			model: "openrouter/anthropic/claude-3.5-sonnet",
			plugin: ["@existing/plugin"],
			mcp: {
				"existing-mcp": { type: "local", command: ["bunx", "existing"] },
			},
			tools: {
				"existing_*": false,
			},
			agent: {
				coder: {
					model: "openrouter/anthropic/claude-opus-4",
					tools: {
						"existing_*": true,
					},
				},
			},
		};

		const newMcps = [
			createMockMcp("linear", "linear_*", ["researcher"]),
			createMockMcp("zai-vision", "zai-vision_*", ["coder", "frontend"]),
		];

		const result = mergeConfig(
			existing,
			existing, // original config same as existing (merge scenario)
			newMcps,
			ENABLED_PLUGIN_CHOICES,
			{}, // no agent models configured
			"anthropic/claude-sonnet-4-20250514", // global model (won't override existing)
			allAgents
		);

		// Everything from existing should be preserved
		expect(result.provider).toEqual(existing.provider);
		expect(result.model).toBe("openrouter/anthropic/claude-3.5-sonnet"); // existing model preserved
		
		// Plugins merged
		expect(result.plugin).toContain("@existing/plugin");
		expect(result.plugin).toContain("@op1/notify");
		expect(result.plugin).toContain("@op1/workspace");
		
		// MCPs merged
		expect(result.mcp).toHaveProperty("existing-mcp");
		expect(result.mcp).toHaveProperty("linear");
		expect(result.mcp).toHaveProperty("zai-vision");
		
		// Tools merged
		expect(result.tools?.["existing_*"]).toBe(false);
		expect(result.tools?.["linear_*"]).toBe(false);
		expect(result.tools?.["zai-vision_*"]).toBe(false);
		
		// Agent config merged
		expect(result.agent?.coder?.model).toBe("openrouter/anthropic/claude-opus-4"); // preserved
		expect(result.agent?.coder?.tools?.["existing_*"]).toBe(true); // preserved
		expect(result.agent?.coder?.tools?.["zai-vision_*"]).toBe(true); // new tool enabled
		expect(result.agent?.researcher?.tools?.["linear_*"]).toBe(true);
		expect(result.agent?.frontend?.tools?.["zai-vision_*"]).toBe(true);
	});
});
