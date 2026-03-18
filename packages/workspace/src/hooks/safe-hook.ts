/**
 * Safe Hook Creation Utilities
 *
 * Prevents non-critical hook failures from crashing the plugin.
 * Inspired by oh-my-opencode's safe-create-hook pattern.
 */

import { homedir, join } from "../bun-compat.js";
import { createLogger } from "../logging.js";

const logger = createLogger("workspace");

type PrivacyMode = "strict" | "balanced";

interface HookFeatureFlags {
	momentum?: boolean;
	completionPromise?: boolean;
	writePolicy?: boolean;
	taskReminder?: boolean;
	autonomyPolicy?: boolean;
	notifications?: boolean;
	verificationAutopilot?: boolean;
	hashAnchoredEdit?: boolean;
	contextScout?: boolean;
	externalScout?: boolean;
	taskGraph?: boolean;
	continuationCommands?: boolean;
	tmuxOrchestration?: boolean;
	boundaryPolicyV2?: boolean;
	claudeCompatibility?: boolean;
	mcpOAuthHelper?: boolean;
}

interface HookThresholds {
	taskReminderThreshold?: number;
	contextLimit?: number;
	compactionThreshold?: number;
	verificationThrottleMs?: number;
}

interface HookNotifications {
	enabled?: boolean;
	desktop?: boolean;
	quietHours?: string;
	timezone?: string;
	privacy?: PrivacyMode;
}

interface HookVerification {
	autopilot?: boolean;
	throttleMs?: number;
}

/**
 * Plugin-level configuration for hook feature flags.
 * Consumers can pass this to control which hooks are active.
 */
export interface HookConfig {
	/** Hooks that should be disabled by name */
	disabledHooks?: string[];
	/** Enable safe hook creation with try-catch (default: false) */
	safeHookCreation?: boolean;
	/** Per-feature hook and workflow switches */
	features?: HookFeatureFlags;
	/** Numeric hook thresholds and limits */
	thresholds?: HookThresholds;
	/** Notification channel preferences */
	notifications?: HookNotifications;
	/** Verification autopilot settings */
	verification?: HookVerification;
}

export interface ResolvedHookConfig {
	disabledHooks: string[];
	safeHookCreation: boolean;
	features: Required<HookFeatureFlags>;
	thresholds: Required<HookThresholds>;
	notifications: {
		enabled: boolean;
		desktop: boolean;
		quietHours: string;
		timezone: string;
		privacy: PrivacyMode;
	};
	verification: {
		autopilot: boolean;
		throttleMs: number;
	};
}

const DEFAULT_FEATURE_FLAGS: Required<HookFeatureFlags> = {
	momentum: true,
	completionPromise: true,
	writePolicy: true,
	taskReminder: true,
	autonomyPolicy: true,
	notifications: true,
	verificationAutopilot: true,
	hashAnchoredEdit: true,
	contextScout: true,
	externalScout: true,
	taskGraph: true,
	continuationCommands: true,
	tmuxOrchestration: true,
	boundaryPolicyV2: true,
	claudeCompatibility: true,
	mcpOAuthHelper: true,
};

const DEFAULT_THRESHOLDS: Required<HookThresholds> = {
	taskReminderThreshold: 20,
	contextLimit: 200_000,
	compactionThreshold: 0.78,
	verificationThrottleMs: 45_000,
};

const DEFAULT_NOTIFICATIONS: Required<HookNotifications> = {
	enabled: true,
	desktop: true,
	quietHours: "",
	timezone: "",
	privacy: "strict",
};

const DEFAULT_VERIFICATION: Required<HookVerification> = {
	autopilot: true,
	throttleMs: DEFAULT_THRESHOLDS.verificationThrottleMs,
};

const DISABLED_HOOKS_BY_FEATURE: Record<keyof HookFeatureFlags, string[]> = {
	momentum: ["momentum"],
	completionPromise: ["completionPromise"],
	writePolicy: ["writePolicy"],
	taskReminder: ["taskReminder"],
	autonomyPolicy: ["autonomyPolicy"],
	notifications: ["tool.execute.after.notificationChannels"],
	verificationAutopilot: [],
	hashAnchoredEdit: ["tool.execute.after.hashAnchorReadEnhancer"],
	contextScout: ["tool.execute.after.contextScout"],
	externalScout: ["tool.execute.after.contextScout"],
	taskGraph: [],
	continuationCommands: [],
	tmuxOrchestration: [],
	boundaryPolicyV2: [],
	claudeCompatibility: [],
	mcpOAuthHelper: [],
};

/**
 * Default hook configuration
 */
export const DEFAULT_HOOK_CONFIG: ResolvedHookConfig = {
	disabledHooks: [],
	safeHookCreation: false,
	features: DEFAULT_FEATURE_FLAGS,
	thresholds: DEFAULT_THRESHOLDS,
	notifications: DEFAULT_NOTIFICATIONS,
	verification: DEFAULT_VERIFICATION,
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	return value as Record<string, unknown>;
}

function parseBooleanEnv(value: string | undefined): boolean | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(normalized)) return true;
	if (["0", "false", "off", "no"].includes(normalized)) return false;
	return null;
}

function parseNumberEnv(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}

function parsePrivacyMode(value: unknown): PrivacyMode | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "strict") return "strict";
	if (normalized === "balanced") return "balanced";
	return null;
}

function mergeHookConfig(base: HookConfig, incoming: HookConfig): HookConfig {
	const stripUndefined = <T extends Record<string, unknown>>(
		value: T | undefined,
	): Partial<T> => {
		if (!value) return {};
		return Object.fromEntries(
			Object.entries(value).filter((entry) => entry[1] !== undefined),
		) as Partial<T>;
	};

	return {
		...base,
		...stripUndefined(incoming as Record<string, unknown>),
		disabledHooks: [
			...(base.disabledHooks ?? []),
			...(incoming.disabledHooks ?? []),
		],
		features: {
			...(base.features ?? {}),
			...stripUndefined(
				incoming.features as Record<string, unknown> | undefined,
			),
		},
		thresholds: {
			...(base.thresholds ?? {}),
			...stripUndefined(
				incoming.thresholds as Record<string, unknown> | undefined,
			),
		},
		notifications: {
			...(base.notifications ?? {}),
			...stripUndefined(
				incoming.notifications as Record<string, unknown> | undefined,
			),
		},
		verification: {
			...(base.verification ?? {}),
			...stripUndefined(
				incoming.verification as Record<string, unknown> | undefined,
			),
		},
	};
}

function getWorkspaceConfigFromRoot(config: unknown): HookConfig | null {
	const root = asRecord(config);
	if (!root) return null;

	const section = asRecord(root.op7_workspace) ?? root;

	const featureValue = asRecord(section.features);
	const thresholdValue = asRecord(section.thresholds);
	const notificationValue = asRecord(section.notifications);
	const verificationValue = asRecord(section.verification);

	const features: HookFeatureFlags = {
		momentum:
			typeof featureValue?.momentum === "boolean"
				? featureValue.momentum
				: undefined,
		completionPromise:
			typeof featureValue?.completionPromise === "boolean"
				? featureValue.completionPromise
				: undefined,
		writePolicy:
			typeof featureValue?.writePolicy === "boolean"
				? featureValue.writePolicy
				: undefined,
		taskReminder:
			typeof featureValue?.taskReminder === "boolean"
				? featureValue.taskReminder
				: undefined,
		autonomyPolicy:
			typeof featureValue?.autonomyPolicy === "boolean"
				? featureValue.autonomyPolicy
				: undefined,
		notifications:
			typeof featureValue?.notifications === "boolean"
				? featureValue.notifications
				: undefined,
		verificationAutopilot:
			typeof featureValue?.verificationAutopilot === "boolean"
				? featureValue.verificationAutopilot
				: undefined,
		hashAnchoredEdit:
			typeof featureValue?.hashAnchoredEdit === "boolean"
				? featureValue.hashAnchoredEdit
				: undefined,
		contextScout:
			typeof featureValue?.contextScout === "boolean"
				? featureValue.contextScout
				: undefined,
		externalScout:
			typeof featureValue?.externalScout === "boolean"
				? featureValue.externalScout
				: undefined,
		taskGraph:
			typeof featureValue?.taskGraph === "boolean"
				? featureValue.taskGraph
				: undefined,
		continuationCommands:
			typeof featureValue?.continuationCommands === "boolean"
				? featureValue.continuationCommands
				: undefined,
		tmuxOrchestration:
			typeof featureValue?.tmuxOrchestration === "boolean"
				? featureValue.tmuxOrchestration
				: undefined,
		boundaryPolicyV2:
			typeof featureValue?.boundaryPolicyV2 === "boolean"
				? featureValue.boundaryPolicyV2
				: undefined,
		claudeCompatibility:
			typeof featureValue?.claudeCompatibility === "boolean"
				? featureValue.claudeCompatibility
				: undefined,
		mcpOAuthHelper:
			typeof featureValue?.mcpOAuthHelper === "boolean"
				? featureValue.mcpOAuthHelper
				: undefined,
	};

	const thresholds: HookThresholds = {
		taskReminderThreshold:
			typeof thresholdValue?.taskReminderThreshold === "number"
				? thresholdValue.taskReminderThreshold
				: undefined,
		contextLimit:
			typeof thresholdValue?.contextLimit === "number"
				? thresholdValue.contextLimit
				: undefined,
		compactionThreshold:
			typeof thresholdValue?.compactionThreshold === "number"
				? thresholdValue.compactionThreshold
				: undefined,
		verificationThrottleMs:
			typeof thresholdValue?.verificationThrottleMs === "number"
				? thresholdValue.verificationThrottleMs
				: undefined,
	};

	const notifications: HookNotifications = {
		enabled:
			typeof notificationValue?.enabled === "boolean"
				? notificationValue.enabled
				: undefined,
		desktop:
			typeof notificationValue?.desktop === "boolean"
				? notificationValue.desktop
				: undefined,
		quietHours:
			typeof notificationValue?.quietHours === "string"
				? notificationValue.quietHours
				: undefined,
		timezone:
			typeof notificationValue?.timezone === "string"
				? notificationValue.timezone
				: undefined,
		privacy: parsePrivacyMode(notificationValue?.privacy) ?? undefined,
	};

	const verification: HookVerification = {
		autopilot:
			typeof verificationValue?.autopilot === "boolean"
				? verificationValue.autopilot
				: undefined,
		throttleMs:
			typeof verificationValue?.throttleMs === "number"
				? verificationValue.throttleMs
				: undefined,
	};

	return {
		disabledHooks: Array.isArray(section.disabledHooks)
			? section.disabledHooks.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
			: undefined,
		safeHookCreation:
			typeof section.safeHookCreation === "boolean"
				? section.safeHookCreation
				: undefined,
		features,
		thresholds,
		notifications,
		verification,
	};
}

async function readHookConfigFile(path: string): Promise<HookConfig | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;

	try {
		const data = await file.json();
		return getWorkspaceConfigFromRoot(data);
	} catch {
		return null;
	}
}

function applyEnvOverrides(config: ResolvedHookConfig): ResolvedHookConfig {
	const notificationsEnabled = parseBooleanEnv(
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS,
	);
	const desktopNotifications = parseBooleanEnv(
		Bun.env.OP7_WORKSPACE_NOTIFICATIONS_DESKTOP,
	);
	const verificationAutopilot = parseBooleanEnv(
		Bun.env.OP7_VERIFICATION_AUTOPILOT,
	);
	const verificationThrottleMs = parseNumberEnv(
		Bun.env.OP7_VERIFICATION_AUTOPILOT_THROTTLE_MS,
	);
	const taskReminderThreshold = parseNumberEnv(
		Bun.env.OP7_WORKSPACE_TASK_REMINDER_THRESHOLD,
	);
	const contextLimit = parseNumberEnv(Bun.env.OP7_WORKSPACE_CONTEXT_LIMIT);
	const compactionThreshold = parseNumberEnv(
		Bun.env.OP7_WORKSPACE_COMPACTION_THRESHOLD,
	);
	const quietHours = Bun.env.OP7_WORKSPACE_NOTIFICATIONS_QUIET_HOURS;
	const timezone = Bun.env.OP7_WORKSPACE_NOTIFICATIONS_TIMEZONE;
	const privacy = parsePrivacyMode(Bun.env.OP7_WORKSPACE_NOTIFICATIONS_PRIVACY);

	const features = {
		...config.features,
		notifications:
			notificationsEnabled === null
				? config.features.notifications
				: notificationsEnabled,
		verificationAutopilot:
			verificationAutopilot === null
				? config.features.verificationAutopilot
				: verificationAutopilot,
	};

	return {
		...config,
		features,
		thresholds: {
			...config.thresholds,
			taskReminderThreshold:
				taskReminderThreshold === null
					? config.thresholds.taskReminderThreshold
					: Math.max(1, Math.floor(taskReminderThreshold)),
			contextLimit:
				contextLimit === null
					? config.thresholds.contextLimit
					: Math.max(10_000, Math.floor(contextLimit)),
			compactionThreshold:
				compactionThreshold === null
					? config.thresholds.compactionThreshold
					: Math.min(0.98, Math.max(0.1, compactionThreshold)),
			verificationThrottleMs:
				verificationThrottleMs === null
					? config.thresholds.verificationThrottleMs
					: Math.max(0, Math.floor(verificationThrottleMs)),
		},
		notifications: {
			...config.notifications,
			enabled:
				notificationsEnabled === null
					? config.notifications.enabled
					: notificationsEnabled,
			desktop:
				desktopNotifications === null
					? config.notifications.desktop
					: desktopNotifications,
			quietHours: quietHours ?? config.notifications.quietHours,
			timezone: timezone ?? config.notifications.timezone,
			privacy: privacy ?? config.notifications.privacy,
		},
		verification: {
			...config.verification,
			autopilot:
				verificationAutopilot === null
					? config.verification.autopilot
					: verificationAutopilot,
			throttleMs:
				verificationThrottleMs === null
					? config.verification.throttleMs
					: Math.max(0, Math.floor(verificationThrottleMs)),
		},
	};
}

function featureDisabledHooks(features: Required<HookFeatureFlags>): string[] {
	return Object.entries(features)
		.filter((entry): entry is [keyof HookFeatureFlags, boolean] => {
			return typeof entry[1] === "boolean";
		})
		.filter(([, enabled]) => !enabled)
		.flatMap(([feature]) => DISABLED_HOOKS_BY_FEATURE[feature]);
}

/**
 * Check if a specific hook is enabled based on config.
 */
export function isHookEnabled(name: string, config: HookConfig): boolean {
	return !(config.disabledHooks ?? []).includes(name);
}

/**
 * Merge user config with defaults.
 */
export function resolveHookConfig(partial?: HookConfig): ResolvedHookConfig {
	const hasVerificationAutopilotOverride =
		typeof partial?.verification?.autopilot === "boolean";
	const merged = mergeHookConfig(DEFAULT_HOOK_CONFIG, partial ?? {});

	const resolved: ResolvedHookConfig = {
		disabledHooks: [...(merged.disabledHooks ?? [])],
		safeHookCreation:
			merged.safeHookCreation ?? DEFAULT_HOOK_CONFIG.safeHookCreation,
		features: {
			...DEFAULT_FEATURE_FLAGS,
			...(merged.features ?? {}),
		},
		thresholds: {
			...DEFAULT_THRESHOLDS,
			...(merged.thresholds ?? {}),
		},
		notifications: {
			...DEFAULT_NOTIFICATIONS,
			...(merged.notifications ?? {}),
		},
		verification: {
			...DEFAULT_VERIFICATION,
			...(merged.verification ?? {}),
		},
	};

	if (resolved.features.externalScout) {
		resolved.features.contextScout = true;
	}

	if (resolved.features.contextScout) {
		resolved.features.externalScout = true;
	}

	if (resolved.features.boundaryPolicyV2) {
		resolved.features.hashAnchoredEdit = true;
		resolved.features.autonomyPolicy = true;
	}

	if (!hasVerificationAutopilotOverride) {
		resolved.verification.autopilot = resolved.features.verificationAutopilot;
	}
	resolved.features.verificationAutopilot = resolved.verification.autopilot;

	const withEnv = applyEnvOverrides(resolved);
	withEnv.features.verificationAutopilot = withEnv.verification.autopilot;
	const disabled = new Set([
		...withEnv.disabledHooks,
		...featureDisabledHooks(withEnv.features),
	]);

	return {
		...withEnv,
		disabledHooks: [...disabled],
	};
}

export async function loadHookConfig(
	directory: string,
): Promise<ResolvedHookConfig> {
	const globalPath = join(homedir(), ".config", "opencode", "workspace.json");
	const projectPath = join(directory, ".opencode", "workspace.json");

	const [globalConfig, projectConfig] = await Promise.all([
		readHookConfigFile(globalPath),
		readHookConfigFile(projectPath),
	]);

	return resolveHookConfig(
		mergeHookConfig(globalConfig ?? {}, projectConfig ?? {}),
	);
}

/**
 * Safely create a hook value. If the factory throws, returns null
 * instead of crashing the plugin initialization.
 *
 * When `safeHookCreation` is false in config, exceptions propagate normally
 * (useful for development/debugging).
 */
export function createSafeHook<T>(
	name: string,
	factory: () => T,
	config: HookConfig,
): T | null {
	if (!isHookEnabled(name, config)) {
		return null;
	}

	const safe = config.safeHookCreation ?? false;

	if (!safe) {
		return factory() ?? null;
	}

	try {
		return factory() ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`[workspace] Hook creation failed: ${name} — ${message}`);
		return null;
	}
}

/**
 * Create a hook function that is guarded at runtime — any error thrown
 * during execution is caught and logged instead of propagating into
 * the OpenCode runtime.
 *
 * Use this for hooks that do async I/O (git commands, file reads, API calls)
 * where an unexpected failure should degrade gracefully.
 */
export function createSafeRuntimeHook<TArgs extends unknown[], TReturn>(
	name: string,
	factory: () => (...args: TArgs) => Promise<TReturn>,
	config: HookConfig,
): ((...args: TArgs) => Promise<TReturn | undefined>) | null {
	const inner = createSafeHook(name, factory, config);
	if (!inner) return null;

	const safe = config.safeHookCreation ?? false;
	if (!safe) return inner as (...args: TArgs) => Promise<TReturn | undefined>;

	return async (...args: TArgs): Promise<TReturn | undefined> => {
		try {
			return await inner(...args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`[workspace] Hook runtime error: ${name} — ${message}`);
			return undefined;
		}
	};
}
