/**
 * Shared utilities for workspace plugin.
 * Uses Bun-native APIs exclusively (no node: imports).
 */

/**
 * Run a command and get stdout using Bun.spawn
 */
export async function runCommand(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	return output;
}

/**
 * Get project ID from git root commit hash (cross-worktree consistent)
 */
export async function getProjectId(directory: string): Promise<string> {
	try {
		const stdout = await runCommand(
			["git", "rev-list", "--max-parents=0", "HEAD"],
			directory,
		);
		return stdout.trim().slice(0, 12);
	} catch {
		// Fallback to directory hash if not a git repo
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(directory);
		return hasher.digest("hex").slice(0, 12);
	}
}

/**
 * Format git diff --numstat output into human-readable summary
 */
export function formatGitStats(output: string): string {
	// Guard against non-string input
	if (typeof output !== "string") {
		return "No file changes detected.";
	}
	const lines = output.trim().split("\n").filter(Boolean);
	if (lines.length === 0) return "No file changes detected.";

	const changes: string[] = [];
	for (const line of lines.slice(0, 10)) {
		// Limit to 10 files
		const [added, removed, file] = line.split("\t");
		if (file) {
			changes.push(`  ${file}: +${added}/-${removed}`);
		}
	}

	if (lines.length > 10) {
		changes.push(`  ... and ${lines.length - 10} more files`);
	}

	return changes.join("\n");
}

/**
 * Get git diff stats to show what files were changed
 */
export async function getGitDiffStats(directory: string): Promise<string> {
	try {
		const stdout = await runCommand(
			["git", "diff", "--numstat", "HEAD"],
			directory,
		);

		if (!stdout.trim()) {
			// Check for staged changes
			const stagedOutput = await runCommand(
				["git", "diff", "--numstat", "--cached"],
				directory,
			);
			if (!stagedOutput.trim()) {
				return "No file changes detected.";
			}
			return formatGitStats(stagedOutput);
		}

		return formatGitStats(stdout);
	} catch {
		return "Could not determine file changes.";
	}
}

/**
 * Bun-compatible error type guard for filesystem errors
 */
export function isSystemError(error: unknown): error is Error & { code: string } {
	return error instanceof Error && "code" in error;
}

/**
 * Escape special regex characters in a string.
 */
export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
