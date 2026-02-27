/**
 * Unit tests for file utility functions
 * Tests Bun-native file operations
 */

import { describe, expect, test } from "bun:test";
import { copyDir, fileExists } from "../index";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");

function join(...parts: string[]): string {
	const normalized = parts
		.filter((part) => part.length > 0)
		.map((part) => part.replace(/\\+/g, "/"));

	if (normalized.length === 0) {
		return "";
	}

	let result = normalized[0];
	for (let index = 1; index < normalized.length; index++) {
		const left = result.replace(/\/+$/, "");
		const right = normalized[index].replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return IS_WINDOWS ? result.replace(/\//g, "\\") : result;
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const marker = join(
		dirPath,
		`.op1-test-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

async function removeDirectory(dirPath: string): Promise<void> {
	const command = IS_WINDOWS
		? ["cmd", "/c", "rmdir", "/s", "/q", dirPath]
		: ["rm", "-rf", dirPath];
	const proc = Bun.spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Failed to remove temp directory: ${dirPath}`);
	}
}

// Local test helpers (avoiding cross-package imports that break rootDir)
async function createTempDir(prefix = "op1-test-"): Promise<{
	path: string;
	cleanup: () => Promise<void>;
}> {
	const tempRoot =
		Bun.env.TMPDIR ||
		Bun.env.TEMP ||
		Bun.env.TMP ||
		(IS_WINDOWS ? "C:\\Temp" : "/tmp");
	const tempPath = join(
		tempRoot,
		`${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	await ensureDirectory(tempPath);
	return {
		path: tempPath,
		cleanup: async () => {
			await removeDirectory(tempPath);
		},
	};
}

async function writeTestFile(path: string, content: string): Promise<void> {
	await Bun.write(path, content);
}

async function readTestFile(path: string): Promise<string> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`Test file not found: ${path}`);
	}
	return await file.text();
}

describe("copyDir", () => {
	test("copies files from source to destination", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			// Create source directory with files
			const srcDir = join(tempDir, "src");
			const destDir = join(tempDir, "dest");
			await ensureDirectory(srcDir);

			await writeTestFile(join(srcDir, "file1.txt"), "content1");
			await writeTestFile(join(srcDir, "file2.txt"), "content2");

			// Copy directory
			const count = await copyDir(srcDir, destDir);

			// Verify files were copied
			expect(count).toBe(2);
			expect(await readTestFile(join(destDir, "file1.txt"))).toBe("content1");
			expect(await readTestFile(join(destDir, "file2.txt"))).toBe("content2");
		} finally {
			await cleanup();
		}
	});

	test("recursively copies nested directories", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			const srcDir = join(tempDir, "src");
			const destDir = join(tempDir, "dest");

			// Create nested structure
			await ensureDirectory(join(srcDir, "nested", "deep"));
			await writeTestFile(join(srcDir, "root.txt"), "root");
			await writeTestFile(join(srcDir, "nested", "nested.txt"), "nested");
			await writeTestFile(join(srcDir, "nested", "deep", "deep.txt"), "deep");

			// Copy directory
			const count = await copyDir(srcDir, destDir);

			// Verify structure
			expect(count).toBe(3);
			expect(await readTestFile(join(destDir, "root.txt"))).toBe("root");
			expect(await readTestFile(join(destDir, "nested", "nested.txt"))).toBe(
				"nested",
			);
			expect(
				await readTestFile(join(destDir, "nested", "deep", "deep.txt")),
			).toBe("deep");
		} finally {
			await cleanup();
		}
	});

	test("creates destination directory if it doesn't exist", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			const srcDir = join(tempDir, "src");
			const destDir = join(tempDir, "nonexistent", "dest");

			await ensureDirectory(srcDir);
			await writeTestFile(join(srcDir, "file.txt"), "content");

			// Copy to non-existent path
			const count = await copyDir(srcDir, destDir);

			expect(count).toBe(1);
			expect(await readTestFile(join(destDir, "file.txt"))).toBe("content");
		} finally {
			await cleanup();
		}
	});

	test("returns 0 for empty directory", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			const srcDir = join(tempDir, "empty");
			const destDir = join(tempDir, "dest");
			await ensureDirectory(srcDir);

			const count = await copyDir(srcDir, destDir);

			expect(count).toBe(0);
		} finally {
			await cleanup();
		}
	});

	test("preserves file contents exactly", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			const srcDir = join(tempDir, "src");
			const destDir = join(tempDir, "dest");
			await ensureDirectory(srcDir);

			// Test with JSON content
			const jsonContent = JSON.stringify(
				{ key: "value", nested: { data: [1, 2, 3] } },
				null,
				2,
			);
			await writeTestFile(join(srcDir, "config.json"), jsonContent);

			await copyDir(srcDir, destDir);

			const copied = await readTestFile(join(destDir, "config.json"));
			expect(copied).toBe(jsonContent);
			expect(JSON.parse(copied)).toEqual({
				key: "value",
				nested: { data: [1, 2, 3] },
			});
		} finally {
			await cleanup();
		}
	});
});

describe("fileExists", () => {
	test("returns true for existing file", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			const filePath = join(tempDir, "test.txt");
			await writeTestFile(filePath, "content");

			const exists = await fileExists(filePath);
			expect(exists).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("returns false for non-existent file", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			const filePath = join(tempDir, "nonexistent.txt");

			const exists = await fileExists(filePath);
			expect(exists).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("returns false for directory path", async () => {
		const { path: tempDir, cleanup } = await createTempDir();

		try {
			const exists = await fileExists(tempDir);
			// Bun.file().exists() returns false for directories
			expect(exists).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
