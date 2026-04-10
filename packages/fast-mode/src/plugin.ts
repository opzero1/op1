import { type Hooks, type Plugin, tool } from "@opencode-ai/plugin";
import { loadFastModeConfig } from "./config.js";
import { normalizeAgentName } from "./normalize.js";
import { applyFastModeServiceTier, shouldApplyFastMode } from "./runtime.js";
import {
	disableAllAgentFastMode,
	type FastModeState,
	getEnabledAgents,
	isAgentFastModeEnabled,
	loadFastModeState,
	saveFastModeState,
	setAgentFastModeEnabled,
} from "./state.js";

function resolveToolTarget(input: {
	target?: string;
	fallbackAgent: string;
}): string {
	const target = input.target ?? input.fallbackAgent;
	const normalized = normalizeAgentName(target);
	if (normalized.length === 0) {
		throw new Error("Target agent is required.");
	}
	return normalized;
}

function formatToolStatus(input: {
	configEnabled: boolean;
	target?: string;
	currentAgent: string;
	state: FastModeState;
}): string {
	const enabledAgents = getEnabledAgents(input.state);
	if (input.target && input.target !== "all") {
		return JSON.stringify(
			{
				action: "status",
				configEnabled: input.configEnabled,
				target: input.target,
				enabled: isAgentFastModeEnabled(input.state, input.target),
			},
			null,
			2,
		);
	}

	return JSON.stringify(
		{
			action: "status",
			configEnabled: input.configEnabled,
			currentAgent: input.currentAgent,
			currentAgentEnabled: isAgentFastModeEnabled(
				input.state,
				input.currentAgent,
			),
			enabledAgents,
		},
		null,
		2,
	);
}

export const FastModePlugin: Plugin = async (ctx) => {
	const workspaceRoot = ctx.directory;
	let memoizedState: FastModeState | null = null;

	async function readState(): Promise<FastModeState> {
		if (memoizedState) return memoizedState;
		memoizedState = await loadFastModeState(workspaceRoot);
		return memoizedState;
	}

	async function writeState(nextState: FastModeState): Promise<void> {
		memoizedState = nextState;
		await saveFastModeState(workspaceRoot, nextState);
	}

	const fast_mode = tool({
		description:
			"Toggle or inspect fast mode state by agent for provider/model guarded request mutation.",
		args: {
			action: tool.schema
				.enum(["status", "on", "off"])
				.describe("Choose status, on, or off."),
			target: tool.schema
				.string()
				.optional()
				.describe(
					"Optional agent name. Defaults to current agent for on/off. Supports 'all' for status/off.",
				),
		},
		async execute(args, toolCtx) {
			const config = await loadFastModeConfig(workspaceRoot);
			const state = await readState();
			const target = args.target ? normalizeAgentName(args.target) : undefined;

			if (args.action === "status") {
				return formatToolStatus({
					configEnabled: config.enabled,
					target,
					currentAgent: toolCtx.agent,
					state,
				});
			}

			if (args.action === "off" && target === "all") {
				const cleared = disableAllAgentFastMode();
				await writeState(cleared);
				return formatToolStatus({
					configEnabled: config.enabled,
					target: "all",
					currentAgent: toolCtx.agent,
					state: cleared,
				});
			}

			if (args.action === "on" && target === "all") {
				return "fast_mode refused: target 'all' is only valid for status/off.";
			}

			const resolvedTarget = resolveToolTarget({
				target,
				fallbackAgent: toolCtx.agent,
			});
			const nextState = setAgentFastModeEnabled(
				state,
				resolvedTarget,
				args.action === "on",
			);
			await writeState(nextState);

			return JSON.stringify(
				{
					action: args.action,
					target: resolvedTarget,
					enabled: isAgentFastModeEnabled(nextState, resolvedTarget),
					enabledAgents: getEnabledAgents(nextState),
				},
				null,
				2,
			);
		},
	});

	const chatParamsHook: NonNullable<Hooks["chat.params"]> = async (
		input,
		output,
	) => {
		const providerID =
			input.provider?.info?.id ?? input.model?.providerID ?? undefined;
		if (!providerID) return;

		const [config, state] = await Promise.all([
			loadFastModeConfig(workspaceRoot),
			readState(),
		]);

		if (
			!shouldApplyFastMode({
				config,
				state,
				request: {
					providerID,
					modelID: input.model.id,
					agentName: input.agent,
				},
			})
		) {
			return;
		}

		applyFastModeServiceTier(output);
	};

	return {
		name: "@op1/fast-mode",
		tool: { fast_mode },
		"chat.params": chatParamsHook,
	};
};

export default FastModePlugin;
