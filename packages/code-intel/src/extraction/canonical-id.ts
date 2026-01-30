/**
 * Canonical ID generation for stable symbol identification
 * 
 * IDs are stable across file renames/moves by using:
 * hash(qualified_name + signature + language)
 */

/**
 * Generate a canonical ID for a symbol
 * Uses SHA-256 hash truncated to 16 hex chars for reasonable uniqueness
 */
export function generateCanonicalId(
	qualifiedName: string,
	signature: string | undefined,
	language: string,
): string {
	const input = `${qualifiedName}::${signature ?? ""}::${language}`;
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex").slice(0, 16);
}

/**
 * Generate a content hash for change detection
 */
export function generateContentHash(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

/**
 * Generate an edge ID from source and target
 */
export function generateEdgeId(
	sourceId: string,
	targetId: string,
	edgeType: string,
): string {
	const input = `${sourceId}::${targetId}::${edgeType}`;
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex").slice(0, 16);
}
