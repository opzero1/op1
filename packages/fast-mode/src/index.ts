import type { Plugin } from "@opencode-ai/plugin";
import { FastModePlugin as FastModeServerPlugin } from "./plugin.js";
import { installFastModePlugin } from "./tui/plugin.js";
import type { TuiPluginApi } from "./tui/types.js";

type FastModeCombinedPlugin = Plugin & {
	id: "@op1/fast-mode";
	tui: (api: TuiPluginApi) => Promise<void>;
};

export const FastModePlugin: FastModeCombinedPlugin = Object.assign(
	FastModeServerPlugin,
	{
		id: "@op1/fast-mode" as const,
		async tui(api: TuiPluginApi) {
			await installFastModePlugin(api);
		},
	},
);

export default FastModePlugin;
export { installFastModePlugin } from "./tui/plugin.js";
export type { TuiPluginApi, TuiPluginModule } from "./tui/types.js";
