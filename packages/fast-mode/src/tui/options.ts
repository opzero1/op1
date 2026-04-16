import type { FastModeConfig } from "../config.js";
import type { FastModeModelTarget, FastModeState } from "../state.js";
import { isModelFastModeEnabled } from "../state.js";

export interface FastModeTuiOption extends FastModeModelTarget {
	title: string;
	value: string;
	description: string;
	category: string;
	onSelect: () => void;
}

export function getFastModeTuiTargets(
	config: FastModeConfig,
): FastModeModelTarget[] {
	return Object.entries(config.providers)
		.flatMap(([providerID, providerConfig]) => {
			if (!providerConfig.enabled) return [];
			return providerConfig.models.map((modelID) => ({ providerID, modelID }));
		})
		.sort((left, right) => {
			if (left.providerID === right.providerID) {
				return left.modelID.localeCompare(right.modelID);
			}
			return left.providerID.localeCompare(right.providerID);
		});
}

export function formatFastModeDialogTitle(
	config: FastModeConfig,
	state: FastModeState,
): string {
	const targets = getFastModeTuiTargets(config);
	const enabledTargets = targets.filter((target) =>
		isModelFastModeEnabled(state, target.providerID, target.modelID),
	);

	if (!config.enabled) {
		return "Fast Mode — config disabled";
	}

	if (targets.length === 0) {
		return "Fast Mode — no configured models";
	}

	if (enabledTargets.length === 0) {
		return "Fast Mode — all models OFF";
	}

	if (enabledTargets.length === 1) {
		const enabledTarget = enabledTargets[0];
		return `Fast Mode — 1 model ON (${enabledTarget?.providerID}/${enabledTarget?.modelID})`;
	}

	return `Fast Mode — ${enabledTargets.length} models ON`;
}

export function buildFastModeDialogOptions(input: {
	config: FastModeConfig;
	state: FastModeState;
	onSelect: (target: FastModeModelTarget) => void;
}): FastModeTuiOption[] {
	return getFastModeTuiTargets(input.config).map((target) => {
		const enabled = isModelFastModeEnabled(
			input.state,
			target.providerID,
			target.modelID,
		);
		return {
			title: `${enabled ? "● ON " : "○ OFF"} ${target.modelID}`,
			value: `${target.providerID}/${target.modelID}`,
			description: enabled
				? `Disable fast mode for ${target.providerID}/${target.modelID}`
				: `Enable fast mode for ${target.providerID}/${target.modelID}`,
			category: target.providerID,
			providerID: target.providerID,
			modelID: target.modelID,
			onSelect: () => input.onSelect(target),
		};
	});
}
