import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	normalizeAgentName,
	normalizeAllowlist,
	normalizeModelID,
	normalizeProviderID,
} from "./normalize.js";

const providerConfigSchema = z.object({
	enabled: z.boolean().optional(),
	agents: z.array(z.string()).optional(),
	models: z.array(z.string()).optional(),
});

const fastModeConfigSchema = z.object({
	enabled: z.boolean().optional(),
	providers: z.record(z.string(), providerConfigSchema).optional(),
});

export type FastModeConfigInput = z.input<typeof fastModeConfigSchema>;

export interface FastModeProviderConfig {
	enabled: boolean;
	agents: string[];
	models: string[];
}

export interface FastModeConfig {
	enabled: boolean;
	providers: Record<string, FastModeProviderConfig>;
}

const fastModeConfigDefaults: FastModeConfig = {
	enabled: false,
	providers: {},
};

export function parseFastModeConfig(input: unknown): FastModeConfig {
	const parsed = fastModeConfigSchema.parse(input);
	const providers: Record<string, FastModeProviderConfig> = {};

	for (const [providerID, providerConfig] of Object.entries(
		parsed.providers ?? {},
	)) {
		const normalizedProviderID = normalizeProviderID(providerID);
		if (normalizedProviderID.length === 0) continue;

		providers[normalizedProviderID] = {
			enabled: providerConfig.enabled ?? true,
			agents: normalizeAllowlist(providerConfig.agents, normalizeAgentName),
			models: normalizeAllowlist(providerConfig.models, normalizeModelID),
		};
	}

	return {
		enabled: parsed.enabled ?? fastModeConfigDefaults.enabled,
		providers,
	};
}

async function readConfigFile(
	path: string,
): Promise<FastModeConfigInput | "invalid" | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;

	try {
		return (await file.json()) as FastModeConfigInput;
	} catch {
		return "invalid";
	}
}

function mergeProviderRecords(
	base: Record<string, z.input<typeof providerConfigSchema>>,
	override: Record<string, z.input<typeof providerConfigSchema>>,
): Record<string, z.input<typeof providerConfigSchema>> {
	const merged: Record<string, z.input<typeof providerConfigSchema>> = {
		...base,
	};

	for (const [providerID, providerConfig] of Object.entries(override)) {
		merged[providerID] = {
			...(merged[providerID] ?? {}),
			...providerConfig,
		};
	}

	return merged;
}

export function mergeFastModeConfigInput(
	base: FastModeConfigInput,
	override: FastModeConfigInput | null,
): FastModeConfigInput {
	if (!override) return base;

	return {
		...base,
		...override,
		providers: mergeProviderRecords(
			base.providers ?? {},
			override.providers ?? {},
		),
	};
}

export function getFastModeConfigPaths(directory: string): {
	globalPath: string;
	projectPath: string;
} {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	const configRoot =
		typeof xdgConfigHome === "string" && xdgConfigHome.length > 0
			? xdgConfigHome
			: join(homedir(), ".config");

	return {
		globalPath: join(configRoot, "opencode", "fast-mode.json"),
		projectPath: join(directory, ".opencode", "fast-mode.json"),
	};
}

export async function loadFastModeConfig(
	directory: string,
): Promise<FastModeConfig> {
	const { globalPath, projectPath } = getFastModeConfigPaths(directory);
	const [globalConfig, projectConfig] = await Promise.all([
		readConfigFile(globalPath),
		readConfigFile(projectPath),
	]);

	if (globalConfig === "invalid" || projectConfig === "invalid") {
		return {
			enabled: false,
			providers: {},
		};
	}

	try {
		return parseFastModeConfig(
			mergeFastModeConfigInput(
				mergeFastModeConfigInput(fastModeConfigDefaults, globalConfig),
				projectConfig,
			),
		);
	} catch {
		return {
			enabled: false,
			providers: {},
		};
	}
}
