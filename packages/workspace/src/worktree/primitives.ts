/**
 * Worktree Primitives
 *
 * File-based mutex, shell escaping, timeout wrapper, and other
 * low-level utilities for worktree management.
 */

import { mkdir, writeFile, unlink, stat } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { isSystemError } from "../utils.js";

// ──────────────────────────────────────────────
// Mutex (file-lock based)
// ──────────────────────────────────────────────

const LOCK_STALE_MS = 30_000; // 30s before considering lock stale

/**
 * Simple file-based mutex for tmux/terminal operations.
 * Uses atomic file creation to prevent race conditions.
 */
export class FileMutex {
	private lockPath: string;

	constructor(name: string, projectId: string) {
		const baseDir = join(homedir(), ".local", "share", "op1", projectId);
		this.lockPath = join(baseDir, `${name}.lock`);
	}

	async acquire(timeoutMs: number = 5000): Promise<() => Promise<void>> {
		const start = Date.now();

		while (Date.now() - start < timeoutMs) {
			try {
				// Check for stale lock
				try {
					const lockStat = await stat(this.lockPath);
					if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
						await unlink(this.lockPath).catch(() => {});
					}
				} catch {
					// Lock file doesn't exist — good
				}

				// Attempt atomic creation (fails if exists)
				await mkdir(dirname(this.lockPath), { recursive: true });
				await writeFile(this.lockPath, `${process.pid}`, { flag: "wx" });

				// Lock acquired — return release function
				return async () => {
					await unlink(this.lockPath).catch(() => {});
				};
			} catch (error) {
				if (isSystemError(error) && error.code === "EEXIST") {
					// Lock held — wait and retry
					await new Promise((r) => setTimeout(r, 100));
					continue;
				}
				throw error;
			}
		}

		throw new Error(`Mutex timeout: could not acquire lock within ${timeoutMs}ms`);
	}
}

// ──────────────────────────────────────────────
// Shell Escaping
// ──────────────────────────────────────────────

/**
 * Escape a string for safe use in a bash shell argument.
 */
export function escapeShell(str: string): string {
	return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a string for use inside AppleScript double-quoted strings.
 */
export function escapeAppleScript(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ──────────────────────────────────────────────
// Timeout Wrapper
// ──────────────────────────────────────────────

/**
 * Wrap a promise with a timeout. Rejects with an error if the promise
 * doesn't resolve within the specified milliseconds.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string = "Operation",
): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
		),
	]);
}

// ──────────────────────────────────────────────
// Branch Name Validation
// ──────────────────────────────────────────────

/**
 * Validate and sanitize a git branch name.
 * Returns null if the name is invalid even after sanitization.
 */
export function sanitizeBranchName(input: string): string | null {
	let name = input
		.trim()
		.replace(/[^\w\-./]/g, "-") // Replace invalid chars
		.replace(/\.{2,}/g, ".") // No consecutive dots
		.replace(/\/{2,}/g, "/") // No consecutive slashes
		.replace(/^[.\-/]+/, "") // No leading dots/dashes/slashes
		.replace(/[.\-/]+$/, "") // No trailing dots/dashes/slashes
		.replace(/\.lock$/i, ""); // No .lock suffix

	if (!name || name.length < 1) return null;
	if (name.length > 200) name = name.slice(0, 200);

	return name;
}
