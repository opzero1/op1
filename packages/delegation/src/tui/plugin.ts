/**
 * Delegation TUI plugin — registers a route, command, and sidebar slot
 * for read-only browsing of the delegation task graph.
 *
 * All task data is read directly from the delegation state file in the
 * workspace directory. No mutations are performed; the only side-effect
 * is navigation when a user selects a task.
 */

import { join } from "../bun-compat.js";
import type { TaskRecord } from "../state.js";
import type { TaskGraphNode, TaskGraphSnapshot } from "../task-graph.js";
import { buildTaskGraph } from "../task-graph.js";
import {
	formatGraphSummaryLine,
	formatNodeCategory,
	formatNodeDescription,
	formatNodeTitle,
} from "./format.js";
import type { TuiPluginApi } from "./types.js";

const ROUTE_NAME = "delegation";
const COMMAND_VALUE = "delegation.tasks";
const TASKS_FILENAME = "task-records.json";
const WORKSPACE_SUBDIR = ".opencode/workspace";

function getRouteSessionID(api: TuiPluginApi): string | undefined {
	const sessionID = api.route.current.params?.sessionID;
	return typeof sessionID === "string" && sessionID.length > 0
		? sessionID
		: undefined;
}

function navigateBack(api: TuiPluginApi): void {
	const sessionID = getRouteSessionID(api);
	if (sessionID) {
		api.route.navigate("session", { sessionID });
		return;
	}

	api.route.navigate("home");
}

function isRelevantToSession(node: TaskGraphNode, sessionID: string): boolean {
	return (
		node.root_session_id === sessionID ||
		node.parent_session_id === sessionID ||
		node.child_session_id === sessionID
	);
}

/**
 * Read task records from the delegation state file.
 *
 * Returns an empty array if the file is missing or unparseable — this
 * is a read-only view, so we degrade gracefully.
 */
async function readTaskRecords(directory: string): Promise<TaskRecord[]> {
	const tasksPath = join(directory, WORKSPACE_SUBDIR, TASKS_FILENAME);

	try {
		const file = Bun.file(tasksPath);
		if (!(await file.exists())) return [];

		const text = await file.text();
		if (!text.trim()) return [];

		const parsed = JSON.parse(text) as {
			version?: number;
			delegations?: Record<string, unknown>;
		};

		if (parsed.version !== 3 || !parsed.delegations) return [];

		return Object.values(parsed.delegations).filter(
			(entry): entry is TaskRecord =>
				entry !== null &&
				typeof entry === "object" &&
				typeof (entry as Record<string, unknown>).id === "string" &&
				typeof (entry as Record<string, unknown>).status === "string",
		);
	} catch {
		return [];
	}
}

async function loadGraph(directory: string): Promise<TaskGraphSnapshot> {
	const records = await readTaskRecords(directory);
	return buildTaskGraph(records, { includeCompleted: true });
}

function filterGraphForSession(
	graph: TaskGraphSnapshot,
	sessionID: string | undefined,
): TaskGraphSnapshot {
	if (!sessionID) return graph;

	const nodes = graph.nodes.filter((node) =>
		isRelevantToSession(node, sessionID),
	);
	if (nodes.length === 0) {
		return {
			generated_at: graph.generated_at,
			summary: {
				total: 0,
				queued: 0,
				blocked: 0,
				running: 0,
				succeeded: 0,
				failed: 0,
				cancelled: 0,
			},
			nodes: [],
			edges: [],
		};
	}

	const nodeIDs = new Set(nodes.map((node) => node.id));
	const edges = graph.edges.filter(
		(edge) => nodeIDs.has(edge.from) && nodeIDs.has(edge.to),
	);

	const summary = nodes.reduce(
		(acc, node) => {
			acc.total += 1;
			acc[node.status] += 1;
			return acc;
		},
		{
			total: 0,
			queued: 0,
			blocked: 0,
			running: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
		},
	);

	return {
		generated_at: graph.generated_at,
		summary,
		nodes,
		edges,
	};
}

function buildDialogOptions(
	api: TuiPluginApi,
	graph: TaskGraphSnapshot,
): Array<{
	title: string;
	value: string;
	description: string;
	category: string;
	onSelect: () => void;
}> {
	return graph.nodes.map((node: TaskGraphNode) => ({
		title: formatNodeTitle(node),
		value: node.id,
		description: formatNodeDescription(node),
		category: formatNodeCategory(node),
		onSelect: () => {
			api.ui.dialog.clear();
			api.route.navigate("session", {
				sessionID: node.child_session_id,
			});
		},
	}));
}

async function showDelegationDialog(api: TuiPluginApi): Promise<void> {
	const directory = api.state.path.directory;
	if (!directory) {
		if (api.route.current.name === ROUTE_NAME) {
			navigateBack(api);
		}
		api.ui.toast({
			variant: "warning",
			message: "Workspace directory not available yet.",
		});
		return;
	}

	const graph = filterGraphForSession(
		await loadGraph(directory),
		getRouteSessionID(api),
	);
	if (graph.nodes.length === 0) {
		if (api.route.current.name === ROUTE_NAME) {
			navigateBack(api);
		}
		api.ui.toast({
			variant: "info",
			message: "No delegation tasks found.",
		});
		return;
	}

	const options = buildDialogOptions(api, graph);

	api.ui.dialog.replace(
		() =>
			api.ui.DialogSelect({
				title: formatGraphSummaryLine(graph),
				placeholder: "Search tasks by description, agent, or status\u2026",
				options,
			}),
		() => {
			// Closing the dialog returns to the launching session when available.
			if (api.route.current.name === ROUTE_NAME) {
				navigateBack(api);
			}
		},
	);
}

/**
 * Install the delegation TUI plugin into the host.
 *
 * Registers:
 * 1. A "delegation" route — opens the task dialog on navigation.
 * 2. A command palette entry — "Delegation Tasks" for keyboard-driven access.
 * 3. No slot in v1 — route + command are the supported entrypoints.
 */
export async function installDelegationPlugin(
	api: TuiPluginApi,
): Promise<void> {
	// -- Route --
	api.route.register([
		{
			name: ROUTE_NAME,
			render: () => {
				// The route itself opens the dialog overlay; the "page" is empty.
				// We trigger the dialog asynchronously so the route renders first.
				Promise.resolve().then(() => showDelegationDialog(api));
				return null;
			},
		},
	]);

	// -- Command --
	api.command.register(() => [
		{
			title: "Delegation Tasks",
			value: COMMAND_VALUE,
			description: "Browse the delegation task graph",
			category: "Delegation",
			onSelect: () => {
				const sessionID =
					api.route.current.name === "session"
						? (getRouteSessionID(api) ?? api.route.current.params?.sessionID)
						: undefined;
				api.route.navigate(ROUTE_NAME, sessionID ? { sessionID } : undefined);
			},
		},
	]);
}
