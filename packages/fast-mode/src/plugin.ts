import { type Hooks, type Plugin, tool } from "@opencode-ai/plugin";
import { loadFastModeConfig } from "./config.js";
import { normalizeModelID, normalizeProviderID } from "./normalize.js";
import { applyFastModeServiceTier, shouldApplyFastMode } from "./runtime.js";
import {
	disableAllFastMode,
	type FastModeState,
	getEnabledModelTargets,
	isModelFastModeEnabled,
	loadFastModeState,
	normalizeFastModeModelTarget,
	saveFastModeState,
	setModelFastModeEnabled,
} from "./state.js";

function parseToolTarget(
	target: string | undefined,
): { providerID: string; modelID: string } | undefined {
	if (!target) return undefined;
	const separatorIndex = target.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === target.length - 1) {
		throw new Error(
			"Target must use 'provider/model' format, for example 'openai/gpt-5.4'.",
		);
	}

	const normalizedTarget = normalizeFastModeModelTarget({
		providerID: normalizeProviderID(target.slice(0, separatorIndex)),
		modelID: normalizeModelID(target.slice(separatorIndex + 1)),
	});

	if (
		normalizedTarget.providerID.length === 0 ||
		normalizedTarget.modelID.length === 0
	) {
		throw new Error(
			"Target must use 'provider/model' format, for example 'openai/gpt-5.4'.",
		);
	}

	return normalizedTarget;
}

function formatToolStatus(input: {
	configEnabled: boolean;
	target?: string;
	state: FastModeState;
}): string {
	const enabledTargets = getEnabledModelTargets(input.state);
	if (input.target && input.target !== "all") {
		const target = parseToolTarget(input.target);
		return JSON.stringify(
			{
				action: "status",
				configEnabled: input.configEnabled,
				target: input.target,
				enabled: target
					? isModelFastModeEnabled(
							input.state,
							target.providerID,
							target.modelID,
						)
					: false,
			},
			null,
			2,
		);
	}

	return JSON.stringify(
		{
			action: "status",
			configEnabled: input.configEnabled,
			enabledTargets,
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
			"Toggle or inspect fast mode state by provider/model target for guarded request mutation.",
		args: {
			action: tool.schema
				.enum(["status", "on", "off"])
				.describe("Choose status, on, or off."),
			target: tool.schema
				.string()
				.optional()
				.describe(
					"Optional provider/model target like 'openai/gpt-5.4'. Supports 'all' for status/off.",
				),
		},
		async execute(args, _toolCtx) {
			const config = await loadFastModeConfig(workspaceRoot);
			const state = await readState();
			const target = args.target ? args.target.trim() : undefined;

			if (args.action === "status") {
				return formatToolStatus({
					configEnabled: config.enabled,
					target,
					state,
				});
			}

			if (args.action === "off" && target === "all") {
				const cleared = disableAllFastMode();
				await writeState(cleared);
				return formatToolStatus({
					configEnabled: config.enabled,
					target: "all",
					state: cleared,
				});
			}

			if (args.action === "on" && target === "all") {
				return "fast_mode refused: target 'all' is only valid for status/off.";
			}

			const resolvedTarget = parseToolTarget(target);
			if (!resolvedTarget) {
				throw new Error(
					"Target is required for on/off and must use 'provider/model' format.",
				);
			}

			const nextState = setModelFastModeEnabled(
				state,
				resolvedTarget.providerID,
				resolvedTarget.modelID,
				args.action === "on",
			);
			await writeState(nextState);

			return JSON.stringify(
				{
					action: args.action,
					target: `${resolvedTarget.providerID}/${resolvedTarget.modelID}`,
					enabled: isModelFastModeEnabled(
						nextState,
						resolvedTarget.providerID,
						resolvedTarget.modelID,
					),
					enabledTargets: getEnabledModelTargets(nextState),
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
