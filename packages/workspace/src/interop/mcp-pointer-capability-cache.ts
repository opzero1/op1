import {
	computeRefreshWindow,
	shouldInvalidateOnError,
} from "./mcp-pointer-contract.js";

export interface McpCapabilityCacheEntry<TCapability> {
	serverId: string;
	capability: TCapability;
	refreshedAtMs: number;
	refreshAtMs: number;
	expiresAtMs: number;
}

export interface McpCapabilityReadResult<TCapability> {
	state: "fresh" | "stale" | "missing";
	entry?: McpCapabilityCacheEntry<TCapability>;
}

export class McpPointerCapabilityCache<TCapability> {
	private readonly entries = new Map<
		string,
		McpCapabilityCacheEntry<TCapability>
	>();

	upsert(input: {
		serverId: string;
		capability: TCapability;
		nowMs?: number;
		softTtlMs?: number;
		hardTtlMs?: number;
		jitterRatio?: number;
	}): McpCapabilityCacheEntry<TCapability> {
		const nowMs = input.nowMs ?? Date.now();
		const window = computeRefreshWindow({
			nowMs,
			softTtlMs: input.softTtlMs,
			hardTtlMs: input.hardTtlMs,
			jitterRatio: input.jitterRatio,
		});

		const next: McpCapabilityCacheEntry<TCapability> = {
			serverId: input.serverId,
			capability: input.capability,
			refreshedAtMs: nowMs,
			refreshAtMs: window.refresh_at_ms,
			expiresAtMs: window.expires_at_ms,
		};

		this.entries.set(input.serverId, next);
		return next;
	}

	read(
		serverId: string,
		nowMs = Date.now(),
	): McpCapabilityReadResult<TCapability> {
		const entry = this.entries.get(serverId);
		if (!entry) {
			return { state: "missing" };
		}

		if (nowMs >= entry.expiresAtMs || nowMs >= entry.refreshAtMs) {
			return { state: "stale", entry };
		}

		return { state: "fresh", entry };
	}

	invalidate(serverId: string): void {
		this.entries.delete(serverId);
	}

	invalidateIfNeeded(input: { serverId: string; errorCode: string }): boolean {
		if (!shouldInvalidateOnError({ errorCode: input.errorCode })) {
			return false;
		}

		this.entries.delete(input.serverId);
		return true;
	}

	handleListChanged(serverId: string): void {
		this.entries.delete(serverId);
	}
}
