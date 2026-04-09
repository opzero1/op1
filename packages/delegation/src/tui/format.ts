/**
 * Terminal-friendly formatting for TaskGraphNode rows.
 *
 * Produces compact, scannable one-liners for dialog options and tree views.
 * Status uses unicode symbols that render well in most terminal emulators.
 */

import type { TaskStatus } from "../state.js";
import type { TaskGraphNode, TaskGraphSnapshot } from "../task-graph.js";

const STATUS_ICON: Record<TaskStatus, string> = {
	running: "\u25CF", // ●
	queued: "\u25CB", // ○
	blocked: "\u25C6", // ◆
	succeeded: "\u2713", // ✓
	failed: "\u2717", // ✗
	cancelled: "\u2298", // ⊘
};

const STATUS_LABEL: Record<TaskStatus, string> = {
	running: "running",
	queued: "queued",
	blocked: "blocked",
	succeeded: "passed",
	failed: "failed",
	cancelled: "cancelled",
};

export function statusIcon(status: TaskStatus): string {
	return STATUS_ICON[status] ?? "?";
}

export function statusLabel(status: TaskStatus): string {
	return STATUS_LABEL[status] ?? status;
}

/**
 * Short single-line title for a task node suitable for dialog option titles.
 *
 * Example: `● running  coder  Implement helper function`
 */
export function formatNodeTitle(node: TaskGraphNode): string {
	const icon = statusIcon(node.status);
	const statusPad = statusLabel(node.status).padEnd(9);
	const agentPad = node.agent.padEnd(10);
	return `${icon} ${statusPad} ${agentPad} ${node.description}`;
}

/**
 * Secondary detail line for a task node suitable for dialog option descriptions.
 *
 * Includes timing, execution mode, merge/verification status when available.
 */
export function formatNodeDescription(node: TaskGraphNode): string {
	const parts: string[] = [`id:${node.id}`];

	if (node.execution_mode) {
		parts.push(node.execution_mode);
	}

	if (node.merge_status && node.merge_status !== "bypassed") {
		parts.push(`merge:${node.merge_status}`);
	}

	if (node.verification_status && node.verification_status !== "pending") {
		parts.push(`verify:${node.verification_status}`);
	}

	if (node.blocked_by.length > 0) {
		parts.push(`blocked by ${node.blocked_by.length} task(s)`);
	}

	if (node.category) {
		parts.push(node.category);
	}

	if (node.branch) {
		parts.push(node.branch);
	}

	return parts.join("  \u00B7  ");
}

/**
 * Group label used as the `category` in DialogSelect options.
 *
 * Groups tasks into "Active", "Completed", and "Blocked" buckets
 * so the dialog visually separates them.
 */
export function formatNodeCategory(node: TaskGraphNode): string {
	if (node.status === "running" || node.status === "queued") {
		return "Active";
	}
	if (node.status === "blocked") {
		return "Blocked";
	}
	return "Completed";
}

/**
 * One-line summary of the entire graph, useful as a slot label or toast.
 *
 * Example: `Tasks: 3 total  ● 1 running  ○ 1 queued  ✓ 1 passed`
 */
export function formatGraphSummaryLine(snapshot: TaskGraphSnapshot): string {
	const { summary } = snapshot;
	const segments: string[] = [`${summary.total} total`];

	if (summary.running > 0) {
		segments.push(`${STATUS_ICON.running} ${summary.running} running`);
	}
	if (summary.queued > 0) {
		segments.push(`${STATUS_ICON.queued} ${summary.queued} queued`);
	}
	if (summary.blocked > 0) {
		segments.push(`${STATUS_ICON.blocked} ${summary.blocked} blocked`);
	}
	if (summary.succeeded > 0) {
		segments.push(`${STATUS_ICON.succeeded} ${summary.succeeded} passed`);
	}
	if (summary.failed > 0) {
		segments.push(`${STATUS_ICON.failed} ${summary.failed} failed`);
	}
	if (summary.cancelled > 0) {
		segments.push(`${STATUS_ICON.cancelled} ${summary.cancelled} cancelled`);
	}

	return `Tasks: ${segments.join("  ")}`;
}

/**
 * Build a flat tree-like text representation of the task graph.
 *
 * Each root node (no depends_on) is rendered at the top level.
 * Dependents are indented beneath their dependency with box-drawing connectors.
 */
export function formatGraphTree(snapshot: TaskGraphSnapshot): string {
	const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
	const childrenOf = new Map<string, string[]>();

	for (const node of snapshot.nodes) {
		for (const depId of node.depends_on) {
			const list = childrenOf.get(depId) ?? [];
			list.push(node.id);
			childrenOf.set(depId, list);
		}
	}

	const roots = snapshot.nodes.filter((n) => n.depends_on.length === 0);
	const lines: string[] = [];
	const visited = new Set<string>();

	function walk(nodeId: string, prefix: string, isLast: boolean): void {
		if (visited.has(nodeId)) return;
		visited.add(nodeId);

		const node = byId.get(nodeId);
		if (!node) return;

		const connector =
			prefix === "" ? "" : isLast ? "\u2514\u2500 " : "\u251C\u2500 ";
		const title = formatNodeTitle(node);
		lines.push(`${prefix}${connector}${title}`);

		const children = childrenOf.get(nodeId) ?? [];
		const childPrefix =
			prefix === "" ? "  " : `${prefix}${isLast ? "   " : "\u2502  "}`;
		for (let i = 0; i < children.length; i++) {
			const childId = children[i];
			if (!childId) continue;
			walk(childId, childPrefix, i === children.length - 1);
		}
	}

	for (let i = 0; i < roots.length; i++) {
		const root = roots[i];
		if (!root) continue;
		walk(root.id, "", i === roots.length - 1);
	}

	// Orphans that weren't visited (cycle-safe)
	for (const node of snapshot.nodes) {
		if (!visited.has(node.id)) {
			lines.push(formatNodeTitle(node));
		}
	}

	return lines.join("\n");
}
