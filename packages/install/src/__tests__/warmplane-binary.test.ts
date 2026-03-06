import { afterEach, describe, expect, test } from "bun:test";
import {
	ensureWarmplaneBinary,
	isWarmplaneBinaryRecommendedDefault,
	resolveWarmplaneBinaryInstallDir,
	resolveWarmplaneBinaryMetadataPath,
	resolveWarmplaneBinaryPath,
	resolveWarmplaneBinaryRelease,
} from "../warmplane-binary";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");
const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await Bun.$`rm -rf ${root}`.quiet();
	}
});

function join(...parts: string[]): string {
	const normalized = parts
		.filter((part) => part.length > 0)
		.map((part) => part.replace(/\\+/g, "/"));

	if (normalized.length === 0) return "";

	let result = normalized[0];
	for (let index = 1; index < normalized.length; index += 1) {
		const left = result.replace(/\/+$/, "");
		const right = normalized[index].replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return IS_WINDOWS ? result.replace(/\//g, "\\") : result;
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const marker = join(
		dirPath,
		`.op1-warmplane-binary-test-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

async function createTempDir(
	prefix = "op1-warmplane-binary-test-",
): Promise<string> {
	const root =
		Bun.env.TMPDIR ||
		Bun.env.TEMP ||
		Bun.env.TMP ||
		(IS_WINDOWS ? "C:\\Temp" : "/tmp");
	const tempPath = join(
		root,
		`${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	await ensureDirectory(tempPath);
	tempRoots.push(tempPath);
	return tempPath;
}

describe("warmplane binary helpers", () => {
	test("resolves mac release metadata with overrides", () => {
		const release = resolveWarmplaneBinaryRelease({
			platform: "darwin",
			arch: "arm64",
			env: {
				OP1_WARMPLANE_VERSION: "1.2.3",
				OP1_WARMPLANE_BIN_URL: "https://example.com/warmplane",
				OP1_WARMPLANE_BIN_SHA256: "abc123",
			},
		});

		expect(release).toEqual({
			version: "1.2.3",
			platform: "darwin-arm64",
			url: "https://example.com/warmplane",
			sha256: "abc123",
		});
	});

	test("installs warmplane from local override path", async () => {
		const root = await createTempDir();
		const homeDir = join(root, "home");
		const sourceBinaryPath = join(root, "source", "warmplane");
		await ensureDirectory(join(root, "source"));
		await Bun.write(sourceBinaryPath, "fake-warmplane-binary");

		const result = await ensureWarmplaneBinary({
			homeDir,
			platform: "darwin",
			arch: "arm64",
			env: {
				OP1_WARMPLANE_BIN_PATH: sourceBinaryPath,
			},
			resolveWhich: () => null,
		});

		expect(result.status).toBe("installed");
		expect(result.source).toBe("local-override");
		expect(result.binaryPath).toBe(resolveWarmplaneBinaryPath(homeDir));
		expect(await Bun.file(resolveWarmplaneBinaryPath(homeDir)).exists()).toBe(
			true,
		);
		expect(await Bun.file(resolveWarmplaneBinaryPath(homeDir)).text()).toBe(
			"fake-warmplane-binary",
		);
		expect(
			await Bun.file(resolveWarmplaneBinaryMetadataPath(homeDir)).exists(),
		).toBe(true);
		expect(resolveWarmplaneBinaryInstallDir(homeDir)).toBe(
			join(homeDir, ".local", "share", "opencode", "bin"),
		);
	});

	test("falls back to PATH on unsupported platforms", async () => {
		const root = await createTempDir();
		const homeDir = join(root, "home");

		const result = await ensureWarmplaneBinary({
			homeDir,
			platform: "linux",
			arch: "x64",
			env: {},
			resolveWhich: () => "/usr/local/bin/warmplane",
		});

		expect(result.status).toBe("path");
		expect(result.binaryPath).toBe("/usr/local/bin/warmplane");
		expect(result.source).toBe("path");
	});

	test("does not recommend the managed default on unsupported platforms without PATH", () => {
		expect(
			isWarmplaneBinaryRecommendedDefault({
				platform: "linux",
				arch: "x64",
				env: {},
				resolveWhich: () => null,
			}),
		).toBe(false);
	});

	test("supports dry-run local installs", async () => {
		const root = await createTempDir();
		const homeDir = join(root, "home");
		const sourceBinaryPath = join(root, "source", "warmplane");
		await ensureDirectory(join(root, "source"));
		await Bun.write(sourceBinaryPath, "fake-warmplane-binary");

		const result = await ensureWarmplaneBinary({
			homeDir,
			dryRun: true,
			platform: "darwin",
			arch: "arm64",
			env: {
				OP1_WARMPLANE_BIN_PATH: sourceBinaryPath,
			},
			resolveWhich: () => null,
		});

		expect(result.status).toBe("would_install");
		expect(await Bun.file(resolveWarmplaneBinaryPath(homeDir)).exists()).toBe(
			false,
		);
	});

	test("supports dry-run release installs without fetching or writing", async () => {
		const root = await createTempDir();
		const homeDir = join(root, "home");
		let fetchCalls = 0;

		const result = await ensureWarmplaneBinary({
			homeDir,
			dryRun: true,
			platform: "darwin",
			arch: "arm64",
			env: {},
			resolveWhich: () => null,
			fetchImpl: async (...args) => {
				fetchCalls += 1;
				return fetch(...args);
			},
		});

		expect(result.status).toBe("would_install");
		expect(result.source).toBe("release-download");
		expect(fetchCalls).toBe(0);
		expect(await Bun.file(resolveWarmplaneBinaryPath(homeDir)).exists()).toBe(
			false,
		);
		expect(
			await Bun.file(resolveWarmplaneBinaryMetadataPath(homeDir)).exists(),
		).toBe(false);
	});
});
