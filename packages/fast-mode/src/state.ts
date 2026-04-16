import { join } from "node:path";
import { z } from "zod";
import { normalizeModelID, normalizeProviderID } from "./normalize.js";

const fastModeStateSchema = z.object({
	providers: z
		.record(
			z.string(),
			z.object({
				models: z.record(z.string(), z.boolean()).optional(),
			}),
		)
		.optional(),
});

export interface FastModeState {
	providers: Record<string, { models: Record<string, boolean> }>;
}

const fastModeStateDefaults: FastModeState = {
	providers: {},
};

export interface FastModeModelTarget {
	providerID: string;
	modelID: string;
}

export function normalizeFastModeModelTarget(input: FastModeModelTarget) {
	return {
		providerID: normalizeProviderID(input.providerID),
		modelID: normalizeModelID(input.modelID),
	};
}

export function parseFastModeState(input: unknown): FastModeState {
	const parsed = fastModeStateSchema.parse(input);
	const providers: FastModeState["providers"] = {};

	for (const [providerID, providerState] of Object.entries(
		parsed.providers ?? {},
	)) {
		const normalizedProviderID = normalizeProviderID(providerID);
		if (normalizedProviderID.length === 0) continue;

		const models: Record<string, boolean> = {};
		for (const [modelID, enabled] of Object.entries(
			providerState.models ?? {},
		)) {
			if (!enabled) continue;
			const normalizedModelID = normalizeModelID(modelID);
			if (normalizedModelID.length === 0) continue;
			models[normalizedModelID] = true;
		}

		if (Object.keys(models).length === 0) continue;
		providers[normalizedProviderID] = { models };
	}

	return { providers };
}

export function getFastModeStatePath(directory: string): string {
	return join(directory, ".opencode", "fast-mode-state.json");
}

export async function loadFastModeState(
	directory: string,
): Promise<FastModeState> {
	const file = Bun.file(getFastModeStatePath(directory));
	if (!(await file.exists())) {
		return { providers: { ...fastModeStateDefaults.providers } };
	}

	try {
		return parseFastModeState(await file.json());
	} catch {
		return { providers: { ...fastModeStateDefaults.providers } };
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

export function isModelFastModeEnabled(
	state: FastModeState,
	providerID: string,
	modelID: string,
): boolean {
	const normalizedTarget = normalizeFastModeModelTarget({
		providerID,
		modelID,
	});
	if (
		normalizedTarget.providerID.length === 0 ||
		normalizedTarget.modelID.length === 0
	) {
		return false;
	}

	return (
		state.providers[normalizedTarget.providerID]?.models[
			normalizedTarget.modelID
		] === true
	);
}

export function setModelFastModeEnabled(
	state: FastModeState,
	providerID: string,
	modelID: string,
	enabled: boolean,
): FastModeState {
	const normalizedTarget = normalizeFastModeModelTarget({
		providerID,
		modelID,
	});
	if (
		normalizedTarget.providerID.length === 0 ||
		normalizedTarget.modelID.length === 0
	) {
		throw new Error(
			"Provider ID and model ID are required for fast mode state updates.",
		);
	}

	const currentProvider = state.providers[normalizedTarget.providerID] ?? {
		models: {},
	};

	if (enabled) {
		return {
			providers: {
				...state.providers,
				[normalizedTarget.providerID]: {
					models: {
						...currentProvider.models,
						[normalizedTarget.modelID]: true,
					},
				},
			},
		};
	}

	const nextModels = { ...currentProvider.models };
	delete nextModels[normalizedTarget.modelID];

	if (Object.keys(nextModels).length === 0) {
		const nextProviders = { ...state.providers };
		delete nextProviders[normalizedTarget.providerID];
		return { providers: nextProviders };
	}

	return {
		providers: {
			...state.providers,
			[normalizedTarget.providerID]: {
				models: nextModels,
			},
		},
	};
}

export function disableAllFastMode(): FastModeState {
	return { providers: {} };
}

export function getEnabledModelTargets(state: FastModeState): string[] {
	return Object.entries(state.providers)
		.flatMap(([providerID, providerState]) =>
			Object.keys(providerState.models)
				.filter((modelID) => providerState.models[modelID])
				.map((modelID) => `${providerID}/${modelID}`),
		)
		.sort();
}
