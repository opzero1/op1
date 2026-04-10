import { join } from "node:path";
import { z } from "zod";
import { normalizeAgentName } from "./normalize.js";

const fastModeStateSchema = z.object({
	agents: z.record(z.string(), z.boolean()).optional(),
});

export interface FastModeState {
	agents: Record<string, boolean>;
}

const fastModeStateDefaults: FastModeState = {
	agents: {},
};

export function parseFastModeState(input: unknown): FastModeState {
	const parsed = fastModeStateSchema.parse(input);
	const agents: Record<string, boolean> = {};

	for (const [agentName, enabled] of Object.entries(parsed.agents ?? {})) {
		if (!enabled) continue;
		const normalized = normalizeAgentName(agentName);
		if (normalized.length === 0) continue;
		agents[normalized] = true;
	}

	return { agents };
}

export function getFastModeStatePath(directory: string): string {
	return join(directory, ".opencode", "fast-mode-state.json");
}

export async function loadFastModeState(
	directory: string,
): Promise<FastModeState> {
	const file = Bun.file(getFastModeStatePath(directory));
	if (!(await file.exists())) {
		return { agents: { ...fastModeStateDefaults.agents } };
	}

	try {
		return parseFastModeState(await file.json());
	} catch {
		return { agents: { ...fastModeStateDefaults.agents } };
	}
}

export async function saveFastModeState(
	directory: string,
	state: FastModeState,
): Promise<void> {
	const normalized = parseFastModeState(state);
	await Bun.write(
		getFastModeStatePath(directory),
		`${JSON.stringify(normalized, null, 2)}\n`,
	);
}

export function isAgentFastModeEnabled(
	state: FastModeState,
	agentName: string,
): boolean {
	const normalized = normalizeAgentName(agentName);
	if (normalized.length === 0) return false;
	return state.agents[normalized] === true;
}

export function setAgentFastModeEnabled(
	state: FastModeState,
	agentName: string,
	enabled: boolean,
): FastModeState {
	const normalized = normalizeAgentName(agentName);
	if (normalized.length === 0) {
		throw new Error("Agent name is required for fast mode state updates.");
	}

	if (enabled) {
		return {
			agents: {
				...state.agents,
				[normalized]: true,
			},
		};
	}

	const nextAgents = { ...state.agents };
	delete nextAgents[normalized];
	return { agents: nextAgents };
}

export function disableAllAgentFastMode(): FastModeState {
	return { agents: {} };
}

export function getEnabledAgents(state: FastModeState): string[] {
	return Object.keys(state.agents)
		.filter((agentName) => state.agents[agentName])
		.sort();
}
