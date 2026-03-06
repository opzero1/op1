export interface McpPointerTelemetrySnapshot {
	pointer_hit: number;
	stale_hit: number;
	forced_refresh: number;
	fallback_events: number;
	mismatch_events: number;
	fallback_rate: number;
	mismatch_rate: number;
}

export class McpPointerTelemetry {
	private pointerHit = 0;
	private staleHit = 0;
	private forcedRefresh = 0;
	private fallbackEvents = 0;
	private mismatchEvents = 0;

	recordPointerHit(input?: { stale?: boolean }): void {
		this.pointerHit += 1;
		if (input?.stale) {
			this.staleHit += 1;
		}
	}

	recordForcedRefresh(): void {
		this.forcedRefresh += 1;
	}

	recordFallbackEvent(): void {
		this.fallbackEvents += 1;
	}

	recordMismatchEvent(): void {
		this.mismatchEvents += 1;
	}

	snapshot(): McpPointerTelemetrySnapshot {
		const denominator = this.pointerHit > 0 ? this.pointerHit : 1;
		return {
			pointer_hit: this.pointerHit,
			stale_hit: this.staleHit,
			forced_refresh: this.forcedRefresh,
			fallback_events: this.fallbackEvents,
			mismatch_events: this.mismatchEvents,
			fallback_rate: Number((this.fallbackEvents / denominator).toFixed(4)),
			mismatch_rate: Number((this.mismatchEvents / denominator).toFixed(4)),
		};
	}
}
