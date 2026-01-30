/**
 * FastSyncCache - Efficient file change detection
 * 
 * Uses a tiered approach:
 * 1. mtime + size check (no I/O, ~1ms)
 * 2. SHA256 hash (if mtime/size changed, ~50ms)
 * 3. Git hash-object (for git repos, ~10ms)
 */

import { join } from "node:path";

interface FileHashRecord {
	hash: string;
	mtime: number;
	size: number;
}

export interface FastSyncCache {
	/** Check if a file has changed */
	hasChanged(filePath: string): Promise<boolean>;

	/** Get current hash for a file */
	getHash(filePath: string): Promise<string | null>;

	/** Update cache entry for a file */
	updateEntry(filePath: string): Promise<void>;

	/** Find all changed files from a list */
	findChangedFiles(filePaths: string[]): Promise<{
		added: string[];
		modified: string[];
		removed: string[];
		unchanged: string[];
	}>;

	/** Clear cache for a file */
	clearFile(filePath: string): void;

	/** Clear entire cache */
	clear(): void;

	/** Save cache to disk */
	save(): Promise<void>;

	/** Get cache statistics */
	stats(): { entries: number; hitRate: number };
}

export interface FastSyncCacheConfig {
	workspaceRoot: string;
	cachePath: string;
	useGitHash?: boolean;
}

export async function createFastSyncCache(
	config: FastSyncCacheConfig,
): Promise<FastSyncCache> {
	const { workspaceRoot, cachePath, useGitHash = true } = config;

	const fileHashes = new Map<string, FileHashRecord>();
	let hits = 0;
	let misses = 0;
	let dirty = false;

	// Check if git is available
	let gitAvailable = false;
	if (useGitHash) {
		try {
			const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
				cwd: workspaceRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			gitAvailable = proc.exitCode === 0;
		} catch {
			gitAvailable = false;
		}
	}

	// Load existing cache
	try {
		const cacheFile = Bun.file(join(workspaceRoot, cachePath));
		if (await cacheFile.exists()) {
			const content = await cacheFile.json();
			if (content.version === 1 && Array.isArray(content.entries)) {
				for (const entry of content.entries) {
					fileHashes.set(entry.path, {
						hash: entry.hash,
						mtime: entry.mtime,
						size: entry.size,
					});
				}
			}
		}
	} catch {
		// Cache doesn't exist or is invalid
	}

	async function computeHash(filePath: string): Promise<string | null> {
		const fullPath = join(workspaceRoot, filePath);

		try {
			// Try git hash first if available
			if (gitAvailable) {
				const proc = Bun.spawn(["git", "hash-object", fullPath], {
					cwd: workspaceRoot,
					stdout: "pipe",
					stderr: "pipe",
				});
				const output = await new Response(proc.stdout).text();
				await proc.exited;

				if (proc.exitCode === 0) {
					return output.trim();
				}
			}

			// Fall back to SHA256
			const file = Bun.file(fullPath);
			const content = await file.arrayBuffer();
			const hasher = new Bun.CryptoHasher("sha256");
			hasher.update(new Uint8Array(content));
			return hasher.digest("hex");
		} catch {
			return null;
		}
	}

	async function getFileStats(
		filePath: string,
	): Promise<{ mtime: number; size: number } | null> {
		const fullPath = join(workspaceRoot, filePath);
		try {
			const file = Bun.file(fullPath);
			const stat = await file.stat();
			return {
				mtime: stat.mtimeMs,
				size: stat.size,
			};
		} catch {
			return null;
		}
	}

	return {
		async hasChanged(filePath: string): Promise<boolean> {
			const cached = fileHashes.get(filePath);
			if (!cached) {
				misses++;
				return true; // New file
			}

			const stats = await getFileStats(filePath);
			if (!stats) {
				return true; // File deleted
			}

			// Fast path: mtime + size unchanged
			if (cached.mtime === stats.mtime && cached.size === stats.size) {
				hits++;
				return false;
			}

			// Slow path: compute hash
			misses++;
			const hash = await computeHash(filePath);
			if (!hash) {
				return true;
			}

			return hash !== cached.hash;
		},

		async getHash(filePath: string): Promise<string | null> {
			const cached = fileHashes.get(filePath);
			const stats = await getFileStats(filePath);

			if (!stats) return null;

			// Fast path
			if (cached && cached.mtime === stats.mtime && cached.size === stats.size) {
				hits++;
				return cached.hash;
			}

			// Compute hash
			misses++;
			return await computeHash(filePath);
		},

		async updateEntry(filePath: string): Promise<void> {
			const stats = await getFileStats(filePath);
			if (!stats) {
				fileHashes.delete(filePath);
				dirty = true;
				return;
			}

			const hash = await computeHash(filePath);
			if (hash) {
				fileHashes.set(filePath, {
					hash,
					mtime: stats.mtime,
					size: stats.size,
				});
				dirty = true;
			}
		},

		async findChangedFiles(filePaths: string[]): Promise<{
			added: string[];
			modified: string[];
			removed: string[];
			unchanged: string[];
		}> {
			const added: string[] = [];
			const modified: string[] = [];
			const unchanged: string[] = [];

			const previousPaths = new Set(fileHashes.keys());
			const currentPaths = new Set(filePaths);

			// Find removed files
			const removed = [...previousPaths].filter((p) => !currentPaths.has(p));

			// Check each current file
			for (const filePath of filePaths) {
				const cached = fileHashes.get(filePath);

				if (!cached) {
					added.push(filePath);
					continue;
				}

				const stats = await getFileStats(filePath);
				if (!stats) {
					// File no longer exists
					continue;
				}

				// Fast path
				if (cached.mtime === stats.mtime && cached.size === stats.size) {
					hits++;
					unchanged.push(filePath);
					continue;
				}

				// Check hash
				misses++;
				const hash = await computeHash(filePath);
				if (hash && hash !== cached.hash) {
					modified.push(filePath);
				} else {
					// mtime changed but content same - update cache
					if (hash) {
						fileHashes.set(filePath, {
							hash,
							mtime: stats.mtime,
							size: stats.size,
						});
						dirty = true;
					}
					unchanged.push(filePath);
				}
			}

			return { added, modified, removed, unchanged };
		},

		clearFile(filePath: string): void {
			if (fileHashes.delete(filePath)) {
				dirty = true;
			}
		},

		clear(): void {
			fileHashes.clear();
			dirty = true;
		},

		async save(): Promise<void> {
			if (!dirty) return;

			const entries = [...fileHashes.entries()].map(([path, record]) => ({
				path,
				hash: record.hash,
				mtime: record.mtime,
				size: record.size,
			}));

			const content = JSON.stringify(
				{
					version: 1,
					updated: Date.now(),
					entries,
				},
				null,
				2,
			);

			await Bun.write(join(workspaceRoot, cachePath), content);
			dirty = false;
		},

		stats(): { entries: number; hitRate: number } {
			const total = hits + misses;
			return {
				entries: fileHashes.size,
				hitRate: total > 0 ? hits / total : 0,
			};
		},
	};
}
