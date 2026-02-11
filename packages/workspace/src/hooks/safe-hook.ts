/**
 * Safe Hook Creation Utilities
 *
 * Prevents non-critical hook failures from crashing the plugin.
 * Inspired by oh-my-opencode's safe-create-hook pattern.
 */

/**
 * Plugin-level configuration for hook feature flags.
 * Consumers can pass this to control which hooks are active.
 */
export interface HookConfig {
	/** Hooks that should be disabled by name */
	disabledHooks?: string[];
	/** Enable safe hook creation with try-catch (default: true) */
	safeHookCreation?: boolean;
}

/**
 * Default hook configuration
 */
export const DEFAULT_HOOK_CONFIG: Required<HookConfig> = {
	disabledHooks: [],
	safeHookCreation: true,
};

/**
 * Check if a specific hook is enabled based on config.
 */
export function isHookEnabled(name: string, config: HookConfig): boolean {
	return !(config.disabledHooks ?? []).includes(name);
}

/**
 * Merge user config with defaults.
 */
export function resolveHookConfig(partial?: HookConfig): Required<HookConfig> {
	return {
		disabledHooks: partial?.disabledHooks ?? DEFAULT_HOOK_CONFIG.disabledHooks,
		safeHookCreation: partial?.safeHookCreation ?? DEFAULT_HOOK_CONFIG.safeHookCreation,
	};
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

	const safe = config.safeHookCreation ?? true;

	if (!safe) {
		return factory() ?? null;
	}

	try {
		return factory() ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[workspace] Hook creation failed: ${name} — ${message}`);
		return null;
	}
}
