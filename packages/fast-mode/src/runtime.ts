import type { FastModeConfig } from "./config.js";
import {
	normalizeAgentName,
	normalizeModelID,
	normalizeProviderID,
} from "./normalize.js";
import { type FastModeState, isAgentFastModeEnabled } from "./state.js";

export interface FastModeRequest {
	providerID: string;
	modelID: string;
	agentName: string;
}

export function shouldApplyFastMode(input: {
	config: FastModeConfig;
	state: FastModeState;
	request: FastModeRequest;
}): boolean {
	if (!input.config.enabled) return false;

	const providerID = normalizeProviderID(input.request.providerID);
	if (providerID.length === 0) return false;

	const providerConfig = input.config.providers[providerID];
	if (!providerConfig || !providerConfig.enabled) return false;

	const modelID = normalizeModelID(input.request.modelID);
	if (modelID.length === 0 || !providerConfig.models.includes(modelID)) {
		return false;
	}

	const agentName = normalizeAgentName(input.request.agentName);
	if (agentName.length === 0 || !providerConfig.agents.includes(agentName)) {
		return false;
	}

	return isAgentFastModeEnabled(input.state, agentName);
}

export function applyFastModeServiceTier(output: {
	options: Record<string, unknown>;
}): void {
	output.options.serviceTier = "priority";
}
