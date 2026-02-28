/**
 * Global test setup for op1 monorepo
 * Loaded before all tests via bunfig.toml
 */

// Set test environment variables
process.env.NODE_ENV = "test";
if (!process.env.OP7_WORKSPACE_LOG_LEVEL) {
	process.env.OP7_WORKSPACE_LOG_LEVEL = "SILENT";
}

/**
 * Bun-native helper for creating temporary test directories
 * Returns cleanup function to remove directory after test
 */
export async function createTempDir(prefix = "op1-test-"): Promise<{
	path: string;
	cleanup: () => Promise<void>;
}> {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const tempPath = await mkdtemp(join(tmpdir(), prefix));

	return {
		path: tempPath,
		cleanup: async () => {
			await rm(tempPath, { recursive: true, force: true });
		},
	};
}

/**
 * Helper to spawn git commands in test environments
 * Ensures git config is set for temp repos
 */
export async function initGitRepo(cwd: string): Promise<void> {
	const commands = [
		["git", "init"],
		["git", "config", "user.name", "Test User"],
		["git", "config", "user.email", "test@example.com"],
	];

	for (const args of commands) {
		const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
		await proc.exited;
		if (proc.exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`Git command failed: ${args.join(" ")}\n${stderr}`);
		}
	}
}

/**
 * Helper to run git commands and return stdout
 */
export async function runGit(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	return { stdout: stdout.trim(), exitCode: proc.exitCode ?? 1 };
}

/**
 * Helper to write files using Bun-native API
 */
export async function writeTestFile(
	path: string,
	content: string,
): Promise<void> {
	await Bun.write(path, content);
}

/**
 * Helper to read files using Bun-native API
 */
export async function readTestFile(path: string): Promise<string> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`Test file not found: ${path}`);
	}
	return await file.text();
}
