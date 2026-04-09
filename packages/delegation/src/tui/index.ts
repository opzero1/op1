/**
 * @op1/delegation/tui — Embedded TUI plugin for the delegation task graph.
 *
 * Default export is a TuiPluginModule that can be loaded by the opencode
 * TUI runtime. Named exports expose the graph builder, format utilities,
 * and types for consumers that want to build their own views.
 */

import { installDelegationPlugin } from "./plugin.js";
import type { TuiPluginApi, TuiPluginModule } from "./types.js";

const DelegationTuiPlugin: TuiPluginModule = {
	id: "@op1/delegation",
	tui: async (api: TuiPluginApi) => {
		await installDelegationPlugin(api);
	},
};

export default DelegationTuiPlugin;

// -- Re-exports for external consumers --

export type { TaskRecord, TaskStatus } from "../state.js";
export type {
	TaskGraphEdge,
	TaskGraphNode,
	TaskGraphSnapshot,
} from "../task-graph.js";
export { buildTaskGraph } from "../task-graph.js";

export {
	formatGraphSummaryLine,
	formatGraphTree,
	formatNodeCategory,
	formatNodeDescription,
	formatNodeTitle,
	statusIcon,
	statusLabel,
} from "./format.js";

export { installDelegationPlugin } from "./plugin.js";
export type {
	TuiCommand,
	TuiPluginApi,
	TuiPluginMeta,
	TuiPluginModule,
	TuiRouteDefinition,
} from "./types.js";
