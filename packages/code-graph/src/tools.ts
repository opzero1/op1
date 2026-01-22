/**
 * Code Graph Tools
 *
 * OpenCode tool definitions for dependency graph analysis.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { CodeGraphIndex } from "./index-manager";
import type { ImpactAnalysis } from "./types";

// Singleton index instance (initialized by plugin)
let graphIndex: CodeGraphIndex | null = null;
let autoBuilt = false;

export function setGraphIndex(index: CodeGraphIndex): void {
	graphIndex = index;
	autoBuilt = false; // Reset on new index
}

async function getIndex(): Promise<CodeGraphIndex> {
	if (!graphIndex) {
		throw new Error("Code graph not initialized. Ensure @op1/code-graph plugin is configured.");
	}
	
	// Auto-build on first use if graph is empty
	if (!autoBuilt) {
		const stats = await graphIndex.getStats();
		if (stats.fileCount === 0) {
			await graphIndex.rebuildGraph();
		}
		autoBuilt = true;
	}
	
	return graphIndex;
}

function formatImpact(impact: ImpactAnalysis): string {
	const lines = [
		`## Impact Analysis: ${impact.target}`,
		"",
		`**Risk Level:** ${impact.riskLevel.toUpperCase()}`,
		`**Assessment:** ${impact.riskExplanation}`,
		"",
	];

	if (impact.directDependents.length > 0) {
		lines.push("### Direct Dependents");
		for (const dep of impact.directDependents.slice(0, 20)) {
			lines.push(`- ${dep}`);
		}
		if (impact.directDependents.length > 20) {
			lines.push(`- ... and ${impact.directDependents.length - 20} more`);
		}
		lines.push("");
	}

	if (impact.transitiveDependents.length > 0) {
		lines.push("### Transitive Dependents");
		lines.push(`Total: ${impact.transitiveDependents.length} files`);
		for (const dep of impact.transitiveDependents.slice(0, 10)) {
			lines.push(`- ${dep}`);
		}
		if (impact.transitiveDependents.length > 10) {
			lines.push(`- ... and ${impact.transitiveDependents.length - 10} more`);
		}
	}

	return lines.join("\n");
}

/**
 * Find what depends on a file or symbol
 */
export const find_dependents: ToolDefinition = tool({
	description: "Find all files that depend on (import from) a given file.",
	args: {
		filePath: tool.schema.string().describe("File path to analyze"),
		transitive: tool.schema.boolean().optional().describe("Include transitive dependents (default: false)"),
	},
	execute: async (args) => {
		try {
			const index = await getIndex();
			const dependents = await index.findDependents(args.filePath, args.transitive ?? false);

			if (dependents.length === 0) {
				return `No files depend on ${args.filePath}`;
			}

			const lines = [`Files that depend on ${args.filePath}:`, ""];
			for (const dep of dependents) {
				lines.push(`- ${dep}`);
			}

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Find what a file depends on
 */
export const find_dependencies: ToolDefinition = tool({
	description: "Find all files that a given file imports/depends on.",
	args: {
		filePath: tool.schema.string().describe("File path to analyze"),
	},
	execute: async (args) => {
		try {
			const index = await getIndex();
			const dependencies = await index.findDependencies(args.filePath);

			if (dependencies.length === 0) {
				return `${args.filePath} has no local dependencies`;
			}

			const lines = [`${args.filePath} depends on:`, ""];
			for (const dep of dependencies) {
				lines.push(`- ${dep}`);
			}

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Analyze impact of changing a file
 */
export const impact_analysis: ToolDefinition = tool({
	description: "Analyze the impact of changing a file. Shows risk level and all affected files.",
	args: {
		filePath: tool.schema.string().describe("File path to analyze"),
	},
	execute: async (args) => {
		try {
			const index = await getIndex();
			const impact = await index.analyzeImpact(args.filePath);
			return formatImpact(impact);
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Get graph status
 */
export const graph_status: ToolDefinition = tool({
	description: "Get status of the dependency graph.",
	args: {},
	execute: async () => {
		try {
			const index = await getIndex();
			const stats = await index.getStats();

			const lines = [
				"## Dependency Graph Status",
				"",
				`- **Files indexed:** ${stats.fileCount}`,
				`- **Nodes:** ${stats.nodeCount}`,
				`- **Edges:** ${stats.edgeCount}`,
			];

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Rebuild the dependency graph
 */
export const graph_rebuild: ToolDefinition = tool({
	description: "Rebuild the dependency graph from scratch.",
	args: {},
	execute: async () => {
		try {
			const index = await getIndex();
			const result = await index.rebuildGraph();
			return `Graph rebuilt: ${result.filesIndexed} files indexed, ${result.edgesCreated} dependencies found.`;
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});
