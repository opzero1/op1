import type { Plugin } from "@opencode-ai/plugin";
import { loadRepromptConfig } from "./config.js";
import { createRetryGuardManager } from "./orchestration/guards.js";
import { createIncomingPromptHook } from "./orchestration/incoming-message.js";
import { createPublicRepromptTools } from "./orchestration/public-tools.js";
import { createTelemetryStore } from "./telemetry/events.js";

export const RepromptPlugin: Plugin = async (ctx) => {
	const config = await loadRepromptConfig(ctx.directory);
	const guards = createRetryGuardManager();
	const telemetryLevel =
		config.telemetry.level === "off"
			? "off"
			: config.telemetry.level === "debug"
				? "debug"
				: "basic";
	const telemetry = createTelemetryStore({
		workspaceRoot: ctx.directory,
		level: telemetryLevel,
		persistEvents: config.telemetry.persistEvents,
	});
	const tools = createPublicRepromptTools({
		workspaceRoot: ctx.directory,
		client: { session: ctx.client.session },
		config,
		guards,
		telemetry,
	});
	const chatMessage =
		config.enabled && config.runtime.mode === "hook-and-helper"
			? createIncomingPromptHook({
					workspaceRoot: ctx.directory,
					config,
					guards,
					telemetry,
				})
			: undefined;

	return {
		tool: tools,
		...(chatMessage ? { "chat.message": chatMessage } : {}),
	};
};

export default RepromptPlugin;
