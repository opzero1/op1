import { hashText } from "../serializer/shared.js";

interface GuardState {
	attempts: number;
	lastAttemptAt: number;
	active: boolean;
}

export interface RetryGuardManager {
	start(input: {
		dedupeKey: string;
		maxAttempts: number;
		cooldownMs: number;
		recursionGuard: boolean;
		now?: number;
	}): { allowed: boolean; attempt: number; suppressionReason?: string };
	finish(dedupeKey: string, now?: number): void;
	buildKey(parts: Array<string | undefined>): string;
}

export function createRetryGuardManager(): RetryGuardManager {
	const state = new Map<string, GuardState>();

	return {
		start(input) {
			const now = input.now ?? Date.now();
			const current = state.get(input.dedupeKey) ?? {
				attempts: 0,
				lastAttemptAt: 0,
				active: false,
			};

			if (input.recursionGuard && current.active) {
				return {
					allowed: false,
					attempt: current.attempts,
					suppressionReason: "recursion-guard",
				};
			}

			if (current.attempts >= input.maxAttempts) {
				return {
					allowed: false,
					attempt: current.attempts,
					suppressionReason: "max-attempts",
				};
			}

			if (
				current.attempts > 0 &&
				now - current.lastAttemptAt < input.cooldownMs
			) {
				return {
					allowed: false,
					attempt: current.attempts,
					suppressionReason: "cooldown-active",
				};
			}

			const next = {
				attempts: current.attempts + 1,
				lastAttemptAt: now,
				active: true,
			};
			state.set(input.dedupeKey, next);
			return { allowed: true, attempt: next.attempts };
		},

		finish(dedupeKey, now = Date.now()) {
			const current = state.get(dedupeKey);
			if (!current) return;
			state.set(dedupeKey, {
				...current,
				active: false,
				lastAttemptAt: now,
			});
		},

		buildKey(parts) {
			return hashText(
				parts.filter((value) => value && value.length > 0).join("::"),
			);
		},
	};
}
