import type { Plugin } from "@opencode-ai/plugin";
import { loadRepromptConfig } from "./config.js";
import { createPublicRepromptTools } from "./orchestration/public-tools.js";

export const RepromptPlugin: Plugin = async (ctx) => {
	const config = await loadRepromptConfig(ctx.directory);
	const tools = createPublicRepromptTools({
		workspaceRoot: ctx.directory,
		client: { session: ctx.client.session },
		config,
	});

	return {
		tool: tools,
	};
};

export default RepromptPlugin;
