import {
	MCP_POINTER_LIFECYCLE_POLICY,
	type McpPointerLifecycleState,
	resolveLifecycleTransition,
} from "./mcp-pointer-contract.js";

type LifecycleAction = (signal: AbortSignal) => Promise<void>;

interface LifecycleRecord {
	state: McpPointerLifecycleState;
	lastError?: string;
}

export interface McpPointerLifecycleSnapshot {
	serverId: string;
	state: McpPointerLifecycleState;
	inFlight: boolean;
	lastError?: string;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) {
		if (signal?.aborted) {
			return Promise.reject(new Error("start aborted by close request"));
		}

		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("start aborted by close request"));
			return;
		}

		const timeout = setTimeout(() => {
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("start aborted by close request"));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class McpPointerLifecycleManager {
	private readonly records = new Map<string, LifecycleRecord>();
	private readonly inFlightStarts = new Map<string, Promise<void>>();
	private readonly startAborters = new Map<string, AbortController>();

	getSnapshot(serverId: string): McpPointerLifecycleSnapshot {
		const record = this.records.get(serverId) ?? { state: "idle" as const };
		return {
			serverId,
			state: record.state,
			inFlight: this.inFlightStarts.has(serverId),
			lastError: record.lastError,
		};
	}

	async start(serverId: string, action: LifecycleAction): Promise<void> {
		const inflight = this.inFlightStarts.get(serverId);
		if (inflight) {
			return inflight;
		}

		const run = this.startInternal(serverId, action).finally(() => {
			this.inFlightStarts.delete(serverId);
			this.startAborters.delete(serverId);
		});
		this.inFlightStarts.set(serverId, run);
		return run;
	}

	async close(serverId: string, action?: LifecycleAction): Promise<void> {
		this.transition(serverId, "close_requested");
		this.startAborters.get(serverId)?.abort();

		const inflight = this.inFlightStarts.get(serverId);
		if (inflight) {
			await inflight.catch(() => {});
		}

		if (action) {
			await action(new AbortController().signal);
		}

		this.transition(serverId, "close_completed");
	}

	private async startInternal(
		serverId: string,
		action: LifecycleAction,
	): Promise<void> {
		this.transition(serverId, "start_requested");
		const controller = new AbortController();
		this.startAborters.set(serverId, controller);
		const signal = controller.signal;
		let attempt = 0;
		let delayMs = MCP_POINTER_LIFECYCLE_POLICY.retry.base_backoff_ms;

		while (attempt < MCP_POINTER_LIFECYCLE_POLICY.retry.max_attempts) {
			if (signal.aborted) {
				throw new Error("start aborted by close request");
			}

			attempt += 1;
			try {
				await action(signal);
				this.transition(serverId, "start_succeeded");
				this.clearError(serverId);
				return;
			} catch (error) {
				this.setError(
					serverId,
					error instanceof Error ? error.message : String(error),
				);
				if (signal.aborted) {
					this.transition(serverId, "close_requested");
					throw error;
				}

				if (attempt >= MCP_POINTER_LIFECYCLE_POLICY.retry.max_attempts) {
					this.transition(serverId, "retry_exhausted");
					throw error;
				}

				this.transition(serverId, "retry_scheduled");
				const jitter = Math.floor(
					delayMs *
						MCP_POINTER_LIFECYCLE_POLICY.retry.jitter_ratio *
						Math.random(),
				);
				await delay(delayMs + jitter, signal);
				if (signal.aborted) {
					throw new Error("start aborted by close request");
				}
				delayMs = Math.min(
					delayMs * 2,
					MCP_POINTER_LIFECYCLE_POLICY.retry.max_backoff_ms,
				);
			}
		}
	}

	private transition(
		serverId: string,
		event: Parameters<typeof resolveLifecycleTransition>[0]["event"],
	): void {
		const current = this.records.get(serverId) ?? { state: "idle" as const };
		const next = resolveLifecycleTransition({ state: current.state, event });
		if (!next) {
			return;
		}

		this.records.set(serverId, {
			...current,
			state: next,
		});
	}

	private setError(serverId: string, message: string): void {
		const current = this.records.get(serverId) ?? { state: "idle" as const };
		this.records.set(serverId, {
			...current,
			lastError: message,
		});
	}

	private clearError(serverId: string): void {
		const current = this.records.get(serverId);
		if (!current) {
			return;
		}

		this.records.set(serverId, {
			state: current.state,
		});
	}
}
