/**
 * Dependency Graph Store
 *
 * SQLite-based storage for the dependency graph with efficient queries.
 */

import { Database } from "bun:sqlite";
import { dirname } from "path";
import { mkdirSync, existsSync } from "fs";
import type { GraphNode, GraphEdge, ImpactAnalysis } from "./types";

/**
 * Graph store using SQLite for persistence
 */
export class GraphStore {
	private db: Database;

	constructor(dbPath: string) {
		// Ensure parent directory exists before opening database
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		this.db = new Database(dbPath);
		this.initTables();
	}

	private initTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS nodes (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				name TEXT NOT NULL,
				file_path TEXT NOT NULL,
				line INTEGER,
				metadata TEXT
			);

			CREATE TABLE IF NOT EXISTS edges (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				from_id TEXT NOT NULL,
				to_id TEXT NOT NULL,
				type TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				UNIQUE(from_id, to_id, type)
			);

			CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
			CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
			CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
			CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
			CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
		`);
	}

	/**
	 * Add or update a node
	 */
	addNode(node: GraphNode): void {
		this.db
			.prepare(`
				INSERT OR REPLACE INTO nodes (id, type, name, file_path, line, metadata)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.run(
				node.id,
				node.type,
				node.name,
				node.filePath,
				node.line ?? null,
				node.metadata ? JSON.stringify(node.metadata) : null
			);
	}

	/**
	 * Add an edge
	 */
	addEdge(edge: GraphEdge): void {
		this.db
			.prepare(`
				INSERT OR REPLACE INTO edges (from_id, to_id, type, weight)
				VALUES (?, ?, ?, ?)
			`)
			.run(edge.from, edge.to, edge.type, edge.weight ?? 1.0);
	}

	/**
	 * Get all nodes that depend on a given node (incoming edges)
	 */
	getDependents(nodeId: string): GraphNode[] {
		const rows = this.db
			.prepare(`
				SELECT n.* FROM nodes n
				JOIN edges e ON e.from_id = n.id
				WHERE e.to_id = ?
			`)
			.all(nodeId) as Array<{
				id: string;
				type: string;
				name: string;
				file_path: string;
				line: number | null;
				metadata: string | null;
			}>;

		return rows.map((r) => ({
			id: r.id,
			type: r.type as GraphNode["type"],
			name: r.name,
			filePath: r.file_path,
			line: r.line ?? undefined,
			metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
		}));
	}

	/**
	 * Get all nodes that a given node depends on (outgoing edges)
	 */
	getDependencies(nodeId: string): GraphNode[] {
		const rows = this.db
			.prepare(`
				SELECT n.* FROM nodes n
				JOIN edges e ON e.to_id = n.id
				WHERE e.from_id = ?
			`)
			.all(nodeId) as Array<{
				id: string;
				type: string;
				name: string;
				file_path: string;
				line: number | null;
				metadata: string | null;
			}>;

		return rows.map((r) => ({
			id: r.id,
			type: r.type as GraphNode["type"],
			name: r.name,
			filePath: r.file_path,
			line: r.line ?? undefined,
			metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
		}));
	}

	/**
	 * Get transitive dependents (all nodes that directly or indirectly depend on target)
	 */
	getTransitiveDependents(nodeId: string, maxDepth: number = 10): string[] {
		const visited = new Set<string>();
		const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

		while (queue.length > 0) {
			const { id, depth } = queue.shift()!;
			if (visited.has(id) || depth > maxDepth) continue;
			visited.add(id);

			const dependents = this.getDependents(id);
			for (const dep of dependents) {
				if (!visited.has(dep.id)) {
					queue.push({ id: dep.id, depth: depth + 1 });
				}
			}
		}

		visited.delete(nodeId); // Remove the original node
		return Array.from(visited);
	}

	/**
	 * Delete all nodes and edges for a file
	 */
	deleteFile(filePath: string): void {
		// Get all node IDs for this file
		const nodes = this.db
			.prepare("SELECT id FROM nodes WHERE file_path = ?")
			.all(filePath) as Array<{ id: string }>;

		const nodeIds = nodes.map((n) => n.id);

		if (nodeIds.length === 0) return;

		// Delete edges involving these nodes
		const deleteEdges = this.db.prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?");
		for (const nodeId of nodeIds) {
			deleteEdges.run(nodeId, nodeId);
		}

		// Delete nodes
		this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
	}

	/**
	 * Get graph statistics
	 */
	getStats(): { nodeCount: number; edgeCount: number; fileCount: number } {
		const nodeCount = (this.db.prepare("SELECT COUNT(*) as count FROM nodes").get() as { count: number }).count;
		const edgeCount = (this.db.prepare("SELECT COUNT(*) as count FROM edges").get() as { count: number }).count;
		const fileCount = (this.db.prepare("SELECT COUNT(DISTINCT file_path) as count FROM nodes").get() as { count: number }).count;

		return { nodeCount, edgeCount, fileCount };
	}

	/**
	 * Perform impact analysis for a file
	 */
	analyzeImpact(filePath: string): ImpactAnalysis {
		// Find the file node
		const fileNode = this.db
			.prepare("SELECT id FROM nodes WHERE file_path = ? AND type = 'file' LIMIT 1")
			.get(filePath) as { id: string } | undefined;

		if (!fileNode) {
			return {
				target: filePath,
				directDependents: [],
				transitiveDependents: [],
				riskLevel: "low",
				riskExplanation: "File not found in dependency graph. Run 'graph_rebuild' to index.",
			};
		}

		const directDependents = this.getDependents(fileNode.id).map((n) => n.filePath);
		const transitiveDependents = this.getTransitiveDependents(fileNode.id);

		// Determine risk level
		let riskLevel: ImpactAnalysis["riskLevel"];
		let riskExplanation: string;

		const totalDependents = new Set([...directDependents, ...transitiveDependents]).size;

		if (totalDependents === 0) {
			riskLevel = "low";
			riskExplanation = "No files depend on this module. Safe to modify.";
		} else if (totalDependents <= 3) {
			riskLevel = "low";
			riskExplanation = `Only ${totalDependents} file(s) depend on this module. Limited impact.`;
		} else if (totalDependents <= 10) {
			riskLevel = "medium";
			riskExplanation = `${totalDependents} files depend on this module. Test affected areas.`;
		} else if (totalDependents <= 25) {
			riskLevel = "high";
			riskExplanation = `${totalDependents} files depend on this module. Significant refactoring risk.`;
		} else {
			riskLevel = "critical";
			riskExplanation = `${totalDependents} files depend on this module. Core infrastructure - proceed with extreme caution.`;
		}

		return {
			target: filePath,
			directDependents: [...new Set(directDependents)],
			transitiveDependents: [...new Set(transitiveDependents)],
			riskLevel,
			riskExplanation,
		};
	}

	/**
	 * Clear all data from the graph
	 */
	clear(): void {
		this.db.exec("DELETE FROM edges");
		this.db.exec("DELETE FROM nodes");
	}

	/**
	 * Close the database
	 */
	close(): void {
		this.db.close();
	}
}
