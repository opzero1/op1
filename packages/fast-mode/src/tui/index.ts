import { installFastModePlugin } from "./plugin.js";
import type { TuiPluginApi, TuiPluginModule } from "./types.js";

const FastModeTuiPlugin: TuiPluginModule = {
	id: "@op1/fast-mode",
	tui: async (api: TuiPluginApi) => {
		await installFastModePlugin(api);
	},
};

export default FastModeTuiPlugin;

export type { FastModeTuiOption } from "./options.js";
export {
	buildFastModeDialogOptions,
	formatFastModeDialogTitle,
	getFastModeTuiTargets,
} from "./options.js";
export { installFastModePlugin } from "./plugin.js";
export type {
	TuiCommand,
	TuiDialogSelectOption,
	TuiPluginApi,
	TuiPluginMeta,
	TuiPluginModule,
	TuiRouteDefinition,
} from "./types.js";
