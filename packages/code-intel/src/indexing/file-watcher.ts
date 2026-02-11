/**
 * FileWatcher - Watch project directory for file changes
 *
 * Uses Bun's native fs.watch with:
 * - Debouncing for rapid changes
 * - Batched event emission
 * - Gitignore + custom ignore patterns
 */

import { join, relative, dirname } from "node:path";
import { readFile } from "node:fs/promises";

// ============================================================================
// Types
// ============================================================================

export type FileChangeType = "add" | "change" | "unlink";

export interface FileChange {
	path: string;
	type: FileChangeType;
	timestamp: number;
}

export interface FileChangeBatch {
	changes: FileChange[];
	batchedAt: number;
}

export interface FileWatcherConfig {
	/** Root directory to watch */
	workspaceRoot: string;
	/** Debounce delay in ms (default: 500) */
	debounceMs?: number;
	/** Additional ignore patterns (glob format) */
	ignorePatterns?: string[];
	/** File extensions to watch (default: ts,tsx,js,jsx,mts,cts,py,pyw) */
	extensions?: string[];
	/** Respect .gitignore (default: true) */
	respectGitignore?: boolean;
}

export interface FileWatcher {
	/** Start watching */
	start(): Promise<void>;

	/** Stop watching */
	stop(): void;

	/** Subscribe to batched file changes */
	onChanges(handler: (batch: FileChangeBatch) => void): () => void;

	/** Get pending changes (not yet emitted) */
	getPendingChanges(): FileChange[];

	/** Check if watcher is active */
	isActive(): boolean;
}

// ============================================================================
// Gitignore Parser
// ============================================================================

interface GitignoreRules {
	patterns: Array<{ pattern: string; negated: boolean; glob: Bun.Glob }>;
}

async function loadGitignore(workspaceRoot: string): Promise<GitignoreRules> {
	const rules: GitignoreRules = { patterns: [] };

	try {
		const gitignorePath = join(workspaceRoot, ".gitignore");
		const content = await readFile(gitignorePath, "utf-8");

		for (const line of content.split("\n")) {
			const trimmed = line.trim();

			// Skip empty lines and comments
			if (!trimmed || trimmed.startsWith("#")) continue;

			const negated = trimmed.startsWith("!");
			const pattern = negated ? trimmed.slice(1) : trimmed;

			// Convert gitignore pattern to glob
			const globPattern = pattern.endsWith("/")
				? `**/${pattern}**`
				: pattern.includes("/")
					? pattern
					: `**/${pattern}`;

			try {
				rules.patterns.push({
					pattern: globPattern,
					negated,
					glob: new Bun.Glob(globPattern),
				});
			} catch {
				// Invalid pattern, skip
			}
		}
	} catch {
		// No .gitignore or can't read it
	}

	return rules;
}

function matchesGitignore(filePath: string, rules: GitignoreRules): boolean {
	let ignored = false;

	for (const rule of rules.patterns) {
		if (rule.glob.match(filePath)) {
			ignored = !rule.negated;
		}
	}

	return ignored;
}

// ============================================================================
// File Watcher Implementation
// ============================================================================

const DEFAULT_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mts", "cts", "py", "pyw"];

const DEFAULT_IGNORE_PATTERNS = [
	"**/node_modules/**",
	"**/.git/**",
	"**/dist/**",
	"**/build/**",
	"**/.opencode/**",
	"**/*.min.js",
	"**/*.bundle.js",
	"**/__pycache__/**",
	"**/.pytest_cache/**",
	"**/venv/**",
	"**/.venv/**",
];

export function createFileWatcher(config: FileWatcherConfig): FileWatcher {
	const {
		workspaceRoot,
		debounceMs = 500,
		ignorePatterns = [],
		extensions = DEFAULT_EXTENSIONS,
		respectGitignore = true,
	} = config;

	// State
	let active = false;
	let watcher: ReturnType<typeof Bun.spawn> | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let gitignoreRules: GitignoreRules = { patterns: [] };

	const pendingChanges = new Map<string, FileChange>();
	const handlers = new Set<(batch: FileChangeBatch) => void>();

	// Pre-compile ignore globs
	const ignoreGlobs = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns].map(
		(p) => new Bun.Glob(p),
	);

	// Extension set for fast lookup
	const extensionSet = new Set(extensions.map((e) => (e.startsWith(".") ? e : `.${e}`)));

	function shouldIgnore(filePath: string): boolean {
		// Check extension
		const ext = filePath.slice(filePath.lastIndexOf("."));
		if (!extensionSet.has(ext)) return true;

		// Check ignore patterns
		for (const glob of ignoreGlobs) {
			if (glob.match(filePath)) return true;
		}

		// Check gitignore
		if (respectGitignore && matchesGitignore(filePath, gitignoreRules)) {
			return true;
		}

		return false;
	}

	function queueChange(path: string, type: FileChangeType): void {
		if (shouldIgnore(path)) return;

		const existing = pendingChanges.get(path);

		// Merge change types intelligently
		if (existing) {
			// add + unlink = no-op (file created and deleted)
			if (existing.type === "add" && type === "unlink") {
				pendingChanges.delete(path);
				return;
			}
			// unlink + add = change (file replaced)
			if (existing.type === "unlink" && type === "add") {
				type = "change";
			}
			// change + change = change (keep latest)
			// add + change = add (still new file)
			if (existing.type === "add" && type === "change") {
				type = "add";
			}
		}

		pendingChanges.set(path, {
			path,
			type,
			timestamp: Date.now(),
		});

		scheduleBatch();
	}

	function scheduleBatch(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		debounceTimer = setTimeout(() => {
			flushBatch();
		}, debounceMs);
	}

	function flushBatch(): void {
		if (pendingChanges.size === 0) return;

		const batch: FileChangeBatch = {
			changes: Array.from(pendingChanges.values()),
			batchedAt: Date.now(),
		};

		pendingChanges.clear();

		for (const handler of handlers) {
			try {
				handler(batch);
			} catch {
				// Swallow handler errors to prevent watcher disruption
			}
		}
	}

	async function watchWithFsEvents(): Promise<void> {
		// Use Bun's native file watching via recursive fs.watch
		const { watch } = await import("node:fs");

		const fsWatcher = watch(
			workspaceRoot,
			{ recursive: true },
			(eventType, filename) => {
				if (!filename || !active) return;

				// Normalize path
				const filePath = filename.replace(/\\/g, "/");

				// Determine change type
				const type: FileChangeType =
					eventType === "rename" ? "change" : "change";

				// For rename events, check if file exists to determine add/unlink
				if (eventType === "rename") {
					const fullPath = join(workspaceRoot, filePath);
					Bun.file(fullPath)
						.exists()
						.then((exists) => {
							queueChange(filePath, exists ? "add" : "unlink");
						})
						.catch(() => {
							queueChange(filePath, "unlink");
						});
				} else {
					queueChange(filePath, type);
				}
			},
		);

		// Store cleanup reference
		(watcher as unknown) = {
			close: () => fsWatcher.close(),
		};
	}

	return {
		async start(): Promise<void> {
			if (active) return;

			// Load gitignore rules
			if (respectGitignore) {
				gitignoreRules = await loadGitignore(workspaceRoot);
			}

			active = true;
			await watchWithFsEvents();
		},

		stop(): void {
			if (!active) return;

			active = false;

			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}

			// Flush remaining changes
			flushBatch();

			if (watcher && typeof (watcher as any).close === "function") {
				(watcher as any).close();
				watcher = null;
			}
		},

		onChanges(handler: (batch: FileChangeBatch) => void): () => void {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},

		getPendingChanges(): FileChange[] {
			return Array.from(pendingChanges.values());
		},

		isActive(): boolean {
			return active;
		},
	};
}
