/**
 * Index Lifecycle State Machine
 *
 * Manages the lifecycle of the code intelligence index:
 * uninitialized → indexing → ready/partial → error
 *
 * Provides type-safe state transitions and status exposure.
 */

import type { IndexLifecycleState } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface LifecycleTransition {
	from: IndexLifecycleState;
	to: IndexLifecycleState;
	timestamp: number;
	reason?: string;
}

export interface LifecycleStatus {
	state: IndexLifecycleState;
	enteredAt: number;
	transitions: LifecycleTransition[];
	error?: Error;
	progress?: {
		current: number;
		total: number;
		phase: string;
	};
}

export interface LifecycleManager {
	/** Get current state */
	getState(): IndexLifecycleState;

	/** Get full status */
	getStatus(): LifecycleStatus;

	/** Transition to indexing state */
	startIndexing(total?: number): void;

	/** Update indexing progress */
	updateProgress(current: number, phase?: string): void;

	/** Transition to ready state */
	markReady(): void;

	/** Transition to partial state (some files failed) */
	markPartial(reason: string): void;

	/** Transition to error state */
	markError(error: Error): void;

	/** Reset to uninitialized */
	reset(): void;

	/** Check if a transition is valid */
	canTransition(to: IndexLifecycleState): boolean;

	/** Subscribe to state changes */
	onStateChange(
		handler: (state: IndexLifecycleState, transition: LifecycleTransition) => void,
	): () => void;
}

// ============================================================================
// Valid Transitions
// ============================================================================

/**
 * State transition graph:
 *
 * uninitialized ──► indexing
 *       ▲              │
 *       │              ├──► ready ──► indexing
 *       │              │      │
 *       │              ├──► partial ──► indexing
 *       │              │      │
 *       │              └──► error
 *       │                     │
 *       └─────────────────────┘ (reset)
 */
const VALID_TRANSITIONS: Record<IndexLifecycleState, IndexLifecycleState[]> = {
	uninitialized: ["indexing"],
	indexing: ["ready", "partial", "error"],
	ready: ["indexing", "uninitialized"],
	partial: ["indexing", "uninitialized"],
	error: ["uninitialized", "indexing"],
};

function isValidTransition(
	from: IndexLifecycleState,
	to: IndexLifecycleState,
): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// Lifecycle Manager Implementation
// ============================================================================

export function createLifecycleManager(): LifecycleManager {
	let state: IndexLifecycleState = "uninitialized";
	let enteredAt = Date.now();
	let currentError: Error | undefined;
	let progress: LifecycleStatus["progress"] | undefined;

	const transitions: LifecycleTransition[] = [];
	const handlers = new Set<
		(state: IndexLifecycleState, transition: LifecycleTransition) => void
	>();

	function transition(to: IndexLifecycleState, reason?: string): void {
		if (!isValidTransition(state, to)) {
			throw new Error(
				`Invalid lifecycle transition: ${state} → ${to}. ` +
					`Valid transitions from '${state}': [${VALID_TRANSITIONS[state].join(", ")}]`,
			);
		}

		const t: LifecycleTransition = {
			from: state,
			to,
			timestamp: Date.now(),
			reason,
		};

		transitions.push(t);

		// Keep only last 100 transitions
		if (transitions.length > 100) {
			transitions.shift();
		}

		state = to;
		enteredAt = t.timestamp;

		// Clear error when transitioning away from error state
		if (to !== "error") {
			currentError = undefined;
		}

		// Clear progress when not indexing
		if (to !== "indexing") {
			progress = undefined;
		}

		// Notify handlers
		for (const handler of handlers) {
			try {
				handler(state, t);
			} catch (error) {
				console.error("[lifecycle] Handler error:", error);
			}
		}
	}

	return {
		getState(): IndexLifecycleState {
			return state;
		},

		getStatus(): LifecycleStatus {
			return {
				state,
				enteredAt,
				transitions: [...transitions],
				error: currentError,
				progress: progress ? { ...progress } : undefined,
			};
		},

		startIndexing(total?: number): void {
			transition("indexing", "Starting indexing");

			if (total !== undefined) {
				progress = {
					current: 0,
					total,
					phase: "initializing",
				};
			}
		},

		updateProgress(current: number, phase?: string): void {
			if (state !== "indexing") {
				throw new Error(
					`Cannot update progress in '${state}' state. Must be in 'indexing' state.`,
				);
			}

			if (!progress) {
				progress = {
					current,
					total: current,
					phase: phase ?? "indexing",
				};
			} else {
				progress.current = current;
				if (phase) {
					progress.phase = phase;
				}
			}
		},

		markReady(): void {
			transition("ready", "Indexing complete");
		},

		markPartial(reason: string): void {
			transition("partial", reason);
		},

		markError(error: Error): void {
			currentError = error;
			transition("error", error.message);
		},

		reset(): void {
			// Direct reset to uninitialized from any state
			const t: LifecycleTransition = {
				from: state,
				to: "uninitialized",
				timestamp: Date.now(),
				reason: "Reset",
			};

			transitions.push(t);
			state = "uninitialized";
			enteredAt = t.timestamp;
			currentError = undefined;
			progress = undefined;

			for (const handler of handlers) {
				try {
					handler(state, t);
				} catch (error) {
					console.error("[lifecycle] Handler error:", error);
				}
			}
		},

		canTransition(to: IndexLifecycleState): boolean {
			return isValidTransition(state, to);
		},

		onStateChange(
			handler: (
				state: IndexLifecycleState,
				transition: LifecycleTransition,
			) => void,
		): () => void {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};
}

// ============================================================================
// State Predicates (for type narrowing)
// ============================================================================

export function isReady(state: IndexLifecycleState): state is "ready" {
	return state === "ready";
}

export function isIndexing(state: IndexLifecycleState): state is "indexing" {
	return state === "indexing";
}

export function isUsable(
	state: IndexLifecycleState,
): state is "ready" | "partial" {
	return state === "ready" || state === "partial";
}

export function isErrored(state: IndexLifecycleState): state is "error" {
	return state === "error";
}

export function isUninitialized(
	state: IndexLifecycleState,
): state is "uninitialized" {
	return state === "uninitialized";
}
