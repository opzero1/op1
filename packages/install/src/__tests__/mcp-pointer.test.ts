import { describe, expect, test } from "bun:test";
import {
	buildMcpPointerIndex,
	installMcpPointerArtifacts,
	validateMcpPointerArtifacts,
} from "../mcp-pointer";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");

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
		`.op1-mcp-pointer-test-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

async function createTempDir(
	prefix = "op1-mcp-pointer-test-",
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
	return tempPath;
}

async function removeDir(path: string): Promise<void> {
	const command = IS_WINDOWS
		? ["cmd", "/c", "rmdir", "/s", "/q", path]
		: ["rm", "-rf", path];
	const proc = Bun.spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	});
	await proc.exited;
}

describe("mcp pointer builder", () => {
	test("builds deterministic pointer index from selected MCPs", () => {
		const index = buildMcpPointerIndex({
			nowMs: Date.parse("2026-03-02T00:00:00.000Z"),
			mcps: [
				{
					id: "grep_app",
					name: "Grep.app",
					toolPattern: "grep_app_*",
					required: "required",
					oauthCapable: true,
					sourceConfigPath: "/tmp/opencode.json",
					config: {
						type: "remote",
						url: "https://mcp.grep.app",
					},
				},
			],
		});

		expect(index.version).toBe(1);
		expect(index.generated_at).toBe("2026-03-02T00:00:00.000Z");
		expect(index.servers).toHaveLength(1);
		expect(index.servers[0]?.id).toBe("grep_app");
		expect(index.servers[0]?.requirement).toBe("required");
		expect(index.servers[0]?.auth.oauth_capable).toBe(true);
		expect(index.servers[0]?.fingerprint_sha256.length).toBeGreaterThan(0);
	});

	test("writes and validates pointer artifacts with active/deferred metrics", async () => {
		const tempDir = await createTempDir();
		try {
			const result = await installMcpPointerArtifacts({
				configDir: tempDir,
				totalCatalogMcpCount: 5,
				mcps: [
					{
						id: "context7",
						name: "Context7",
						toolPattern: "context7_*",
						required: "required",
						sourceConfigPath: join(tempDir, "opencode.json"),
						config: { type: "remote", url: "https://mcp.context7.com/mcp" },
					},
				],
			});

			expect(result.applied).toBe(true);
			expect(result.activeMcpCount).toBe(1);
			expect(result.deferredMcpCount).toBe(4);

			const integrity = await validateMcpPointerArtifacts({
				indexPath: result.indexPath,
				checksumPath: result.checksumPath,
			});
			expect(integrity.ok).toBe(true);
		} finally {
			await removeDir(tempDir);
		}
	});

	test("supports dry-run pointer artifact preview", async () => {
		const tempDir = await createTempDir();
		try {
			const result = await installMcpPointerArtifacts({
				configDir: tempDir,
				totalCatalogMcpCount: 3,
				dryRun: true,
				mcps: [],
			});

			expect(result.applied).toBe(false);
			expect(result.fileWrites).toBe(2);
			expect(await Bun.file(result.indexPath).exists()).toBe(false);
		} finally {
			await removeDir(tempDir);
		}
	});
});
