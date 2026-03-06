const METADATA_TTL_MS = 15 * 60 * 1000;

export interface PendingToolMetadata {
	title?: string;
	metadata?: Record<string, unknown>;
	storedAt: number;
}

function createKey(sessionID: string, callID: string): string {
	return `${sessionID}:${callID}`;
}

export function createToolMetadataStore() {
	const pending = new Map<string, PendingToolMetadata>();

	function cleanupExpired(now = Date.now()): void {
		for (const [key, value] of pending.entries()) {
			if (now - value.storedAt <= METADATA_TTL_MS) continue;
			pending.delete(key);
		}
	}

	function storeToolMetadata(
		sessionID: string,
		callID: string,
		input: {
			title?: string;
			metadata?: Record<string, unknown>;
		},
	): void {
		cleanupExpired();
		pending.set(createKey(sessionID, callID), {
			title: input.title,
			metadata: input.metadata,
			storedAt: Date.now(),
		});
	}

	function consumeToolMetadata(
		sessionID: string,
		callID: string,
	): PendingToolMetadata | undefined {
		cleanupExpired();
		const key = createKey(sessionID, callID);
		const value = pending.get(key);
		if (!value) return undefined;
		pending.delete(key);
		return value;
	}

	function clearPendingStore(): void {
		pending.clear();
	}

	function getPendingStoreSize(): number {
		cleanupExpired();
		return pending.size;
	}

	return {
		storeToolMetadata,
		consumeToolMetadata,
		clearPendingStore,
		getPendingStoreSize,
	};
}

export type ToolMetadataStore = ReturnType<typeof createToolMetadataStore>;
