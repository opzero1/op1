import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const runtimeModeSchema = z.enum(["helper-only", "hook-and-helper"]);
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export const promptModeSchema = z.enum(["auto", "compiler"]);
export type PromptMode = z.infer<typeof promptModeSchema>;

export const oracleModeSchema = z.enum(["disabled", "suggest", "allow"]);
export type OracleMode = z.infer<typeof oracleModeSchema>;

export const telemetryLevelSchema = z.enum(["off", "basic", "debug"]);
export type TelemetryLevel = z.infer<typeof telemetryLevelSchema>;

export const runtimeConfigSchema = z.object({
	mode: runtimeModeSchema.optional(),
	promptMode: promptModeSchema.optional(),
});

export const retryPolicySchema = z.object({
	maxAttempts: z.number().int().positive().optional(),
	cooldownMs: z.number().int().nonnegative().optional(),
	dedupeWindowMs: z.number().int().positive().optional(),
	recursionGuard: z.boolean().optional(),
});

export const bundleBudgetSchema = z.object({
	maxTokens: z.number().int().positive().optional(),
	maxBytes: z.number().int().positive().optional(),
	maxSlices: z.number().int().positive().optional(),
	minRequiredSlices: z.number().int().nonnegative().optional(),
});

export const privacyPolicySchema = z.object({
	blockedGlobs: z.array(z.string()).optional(),
	blockedPatterns: z.array(z.string()).optional(),
	redactPatterns: z.array(z.string()).optional(),
	allowHiddenFiles: z.boolean().optional(),
});

export const oraclePolicySchema = z.object({
	mode: oracleModeSchema.optional(),
	maxBundleTokens: z.number().int().positive().optional(),
	maxCallsPerSession: z.number().int().positive().optional(),
});

export const telemetryPolicySchema = z.object({
	level: telemetryLevelSchema.optional(),
	persistEvents: z.boolean().optional(),
});

export const repromptConfigSchema = z.object({
	enabled: z.boolean().optional(),
	runtime: runtimeConfigSchema.optional(),
	retry: retryPolicySchema.optional(),
	bundle: bundleBudgetSchema.optional(),
	privacy: privacyPolicySchema.optional(),
	oracle: oraclePolicySchema.optional(),
	telemetry: telemetryPolicySchema.optional(),
});

export type RepromptConfigInput = z.input<typeof repromptConfigSchema>;

export const repromptConfigDefaults = {
	enabled: false,
	runtime: {
		mode: "hook-and-helper",
		promptMode: "auto",
	},
	retry: {
		maxAttempts: 1,
		cooldownMs: 5_000,
		dedupeWindowMs: 60_000,
		recursionGuard: true,
	},
	bundle: {
		maxTokens: 6_000,
		maxBytes: 24_000,
		maxSlices: 12,
		minRequiredSlices: 1,
	},
	privacy: {
		blockedGlobs: [] as string[],
		blockedPatterns: [] as string[],
		redactPatterns: [] as string[],
		allowHiddenFiles: false,
	},
	oracle: {
		mode: "suggest",
		maxBundleTokens: 3_000,
		maxCallsPerSession: 1,
	},
	telemetry: {
		level: "basic",
		persistEvents: true,
	},
};

export function parseRepromptConfig(input: unknown) {
	const parsed = repromptConfigSchema.parse(input);

	return {
		enabled: parsed.enabled ?? repromptConfigDefaults.enabled,
		runtime: {
			...repromptConfigDefaults.runtime,
			...parsed.runtime,
		},
		retry: {
			...repromptConfigDefaults.retry,
			...parsed.retry,
		},
		bundle: {
			...repromptConfigDefaults.bundle,
			...parsed.bundle,
		},
		privacy: {
			...repromptConfigDefaults.privacy,
			...parsed.privacy,
			blockedGlobs:
				parsed.privacy?.blockedGlobs ??
				repromptConfigDefaults.privacy.blockedGlobs,
			blockedPatterns:
				parsed.privacy?.blockedPatterns ??
				repromptConfigDefaults.privacy.blockedPatterns,
			redactPatterns:
				parsed.privacy?.redactPatterns ??
				repromptConfigDefaults.privacy.redactPatterns,
		},
		oracle: {
			...repromptConfigDefaults.oracle,
			...parsed.oracle,
		},
		telemetry: {
			...repromptConfigDefaults.telemetry,
			...parsed.telemetry,
		},
	};
}

export type RepromptConfig = ReturnType<typeof parseRepromptConfig>;

async function readRepromptConfigFile(
	path: string,
): Promise<RepromptConfigInput | "invalid" | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as RepromptConfigInput;
	} catch {
		return "invalid";
	}
}

function mergeRepromptConfigInput(
	base: RepromptConfigInput,
	override: RepromptConfigInput | null,
): RepromptConfigInput {
	if (!override) return base;
	return {
		...base,
		...override,
		runtime: { ...(base.runtime ?? {}), ...(override.runtime ?? {}) },
		retry: { ...(base.retry ?? {}), ...(override.retry ?? {}) },
		bundle: { ...(base.bundle ?? {}), ...(override.bundle ?? {}) },
		privacy: { ...(base.privacy ?? {}), ...(override.privacy ?? {}) },
		oracle: { ...(base.oracle ?? {}), ...(override.oracle ?? {}) },
		telemetry: { ...(base.telemetry ?? {}), ...(override.telemetry ?? {}) },
	};
}

export async function loadRepromptConfig(
	directory: string,
): Promise<RepromptConfig> {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	const configRoot =
		typeof xdgConfigHome === "string" && xdgConfigHome.length > 0
			? xdgConfigHome
			: join(homedir(), ".config");
	const globalPath = join(configRoot, "opencode", "reprompt.json");
	const projectPath = join(directory, ".opencode", "reprompt.json");
	const [globalConfig, projectConfig] = await Promise.all([
		readRepromptConfigFile(globalPath),
		readRepromptConfigFile(projectPath),
	]);
	if (globalConfig === "invalid" || projectConfig === "invalid") {
		return parseRepromptConfig({ enabled: false });
	}

	return parseRepromptConfig(
		mergeRepromptConfigInput(
			mergeRepromptConfigInput({ enabled: true }, globalConfig),
			projectConfig,
		),
	);
}
