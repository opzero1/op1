export function normalizeProviderID(value: string): string {
	return value.trim().toLowerCase();
}

export function normalizeAgentName(value: string): string {
	return value.trim().toLowerCase();
}

export function normalizeModelID(value: string): string {
	return value.trim();
}

export function normalizeAllowlist(
	values: string[] | undefined,
	normalize: (value: string) => string,
): string[] {
	if (!values || values.length === 0) return [];

	const deduped = new Set<string>();
	for (const value of values) {
		const normalized = normalize(value);
		if (normalized.length > 0) deduped.add(normalized);
	}

	return [...deduped];
}
