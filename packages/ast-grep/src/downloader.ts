/**
 * AST-Grep Binary Downloader
 *
 * Downloads ast-grep binary from GitHub releases with platform detection.
 */

import { homeDirectory, runtimeArch, runtimePlatform } from "./runtime";
import { extractZip } from "./zip-extractor";

const REPO = "ast-grep/ast-grep";

// IMPORTANT: Update this when bumping @ast-grep/cli in package.json
// This is only used as fallback when @ast-grep/cli package.json cannot be read
const DEFAULT_VERSION = "0.40.0";

type LogLevel = "debug" | "info" | "warn" | "error";

interface AstGrepLogEntry {
	level: LogLevel;
	message: string;
	extra?: Record<string, unknown>;
}

export type AstGrepLogger = (entry: AstGrepLogEntry) => Promise<void> | void;

let astGrepLogger: AstGrepLogger | null = null;

export function setAstGrepLogger(logger: AstGrepLogger | null): void {
	astGrepLogger = logger;
}

async function log(
	level: LogLevel,
	message: string,
	extra?: Record<string, unknown>,
): Promise<void> {
	if (!astGrepLogger) return;

	try {
		await astGrepLogger({ level, message, extra });
	} catch {
		// Ignore logging failures to avoid interrupting tool execution.
	}
}

function joinPath(...parts: string[]): string {
	const normalizedParts = parts
		.filter((part) => part.length > 0)
		.map((part, index) => {
			if (index === 0) {
				return part.replace(/[\\/]+$/g, "");
			}
			return part.replace(/^[\\/]+|[\\/]+$/g, "");
		});

	return normalizedParts.join("/");
}

function getHomeDir(): string {
	return homeDirectory();
}

async function getAstGrepVersion(): Promise<string> {
	try {
		const pkgPath = Bun.resolveSync(
			"@ast-grep/cli/package.json",
			import.meta.dir,
		);
		const pkg = (await Bun.file(pkgPath).json()) as { version?: string };
		if (typeof pkg.version === "string" && pkg.version.length > 0) {
			return pkg.version;
		}

		return DEFAULT_VERSION;
	} catch {
		return DEFAULT_VERSION;
	}
}

interface PlatformInfo {
	arch: string;
	os: string;
}

const PLATFORM_MAP: Record<string, PlatformInfo> = {
	"darwin-arm64": { arch: "aarch64", os: "apple-darwin" },
	"darwin-x64": { arch: "x86_64", os: "apple-darwin" },
	"linux-arm64": { arch: "aarch64", os: "unknown-linux-gnu" },
	"linux-x64": { arch: "x86_64", os: "unknown-linux-gnu" },
	"win32-x64": { arch: "x86_64", os: "pc-windows-msvc" },
	"win32-arm64": { arch: "aarch64", os: "pc-windows-msvc" },
	"win32-ia32": { arch: "i686", os: "pc-windows-msvc" },
};

export function getCacheDir(): string {
	const platform = runtimePlatform();
	if (platform === "win32") {
		const localAppData = Bun.env.LOCALAPPDATA || Bun.env.APPDATA;
		const base = localAppData || joinPath(getHomeDir(), "AppData", "Local");
		return joinPath(base, "op1-ast-grep", "bin");
	}

	const xdgCache = Bun.env.XDG_CACHE_HOME;
	const base = xdgCache || joinPath(getHomeDir(), ".cache");
	return joinPath(base, "op1-ast-grep", "bin");
}

export function getBinaryName(): string {
	return runtimePlatform() === "win32" ? "ast-grep.exe" : "ast-grep";
}

export function getCachedBinaryPath(): string | null {
	const binaryPath = joinPath(getCacheDir(), getBinaryName());
	return Bun.file(binaryPath).size > 0 ? binaryPath : null;
}

export async function downloadAstGrep(
	version: string = DEFAULT_VERSION,
): Promise<string | null> {
	const platform = runtimePlatform();
	const detectedArch = runtimeArch();
	const platformKey = `${platform}-${detectedArch}`;
	const platformInfo = PLATFORM_MAP[platformKey];

	if (!platformInfo) {
		await log("error", `Unsupported platform: ${platformKey}`, {
			platform: platform,
			arch: detectedArch,
		});
		return null;
	}

	const cacheDir = getCacheDir();
	const binaryName = getBinaryName();
	const binaryPath = joinPath(cacheDir, binaryName);

	if (Bun.file(binaryPath).size > 0) {
		return binaryPath;
	}

	const { arch, os } = platformInfo;
	const assetName = `app-${arch}-${os}.zip`;
	const downloadUrl = `https://github.com/${REPO}/releases/download/${version}/${assetName}`;

	await log("info", "Downloading ast-grep binary", {
		version,
		asset: assetName,
		url: downloadUrl,
	});

	try {
		const response = await fetch(downloadUrl, { redirect: "follow" });

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const archivePath = joinPath(cacheDir, assetName);
		const arrayBuffer = await response.arrayBuffer();
		await Bun.write(archivePath, arrayBuffer);

		await extractZip(archivePath, cacheDir);

		if (await Bun.file(archivePath).exists()) {
			await Bun.file(archivePath).unlink();
		}

		if (platform !== "win32" && (await Bun.file(binaryPath).exists())) {
			Bun.spawnSync(["chmod", "755", binaryPath], {
				stdout: "ignore",
				stderr: "ignore",
			});
		}

		await log("info", "ast-grep binary ready", {
			path: binaryPath,
		});

		return binaryPath;
	} catch (err) {
		await log(
			"error",
			`Failed to download ast-grep: ${err instanceof Error ? err.message : String(err)}`,
			{ url: downloadUrl },
		);
		return null;
	}
}

export async function ensureAstGrepBinary(): Promise<string | null> {
	const cachedPath = getCachedBinaryPath();
	if (cachedPath) {
		return cachedPath;
	}

	const version = await getAstGrepVersion();
	return downloadAstGrep(version);
}
