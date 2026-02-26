/**
 * AST-Grep Constants
 *
 * Language lists, path resolution, environment checks.
 */

import { getCachedBinaryPath } from "./downloader";
import { runtimeArch, runtimePlatform } from "./runtime";

type Platform = "darwin" | "linux" | "win32" | "unsupported";

function isValidBinary(filePath: string): boolean {
	return Bun.file(filePath).size > 10000;
}

function dirname(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const separatorIndex = normalized.lastIndexOf("/");

	if (separatorIndex < 0) {
		return ".";
	}

	if (separatorIndex === 0) {
		return "/";
	}

	return normalized.slice(0, separatorIndex);
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

function getPlatformPackageName(): string | null {
	const platform = runtimePlatform() as Platform;
	const arch = runtimeArch();

	const platformMap: Record<string, string> = {
		"darwin-arm64": "@ast-grep/cli-darwin-arm64",
		"darwin-x64": "@ast-grep/cli-darwin-x64",
		"linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
		"linux-x64": "@ast-grep/cli-linux-x64-gnu",
		"win32-x64": "@ast-grep/cli-win32-x64-msvc",
		"win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
		"win32-ia32": "@ast-grep/cli-win32-ia32-msvc",
	};

	return platformMap[`${platform}-${arch}`] ?? null;
}

export function findSgCliPathSync(): string | null {
	const platform = runtimePlatform();
	const binaryName = platform === "win32" ? "sg.exe" : "sg";

	const cachedPath = getCachedBinaryPath();
	if (cachedPath && isValidBinary(cachedPath)) {
		return cachedPath;
	}

	try {
		const cliPkgPath = Bun.resolveSync(
			"@ast-grep/cli/package.json",
			import.meta.dir,
		);
		const cliDir = dirname(cliPkgPath);
		const sgPath = joinPath(cliDir, binaryName);

		if (isValidBinary(sgPath)) {
			return sgPath;
		}
	} catch {
		// @ast-grep/cli not installed
	}

	const platformPkg = getPlatformPackageName();
	if (platformPkg) {
		try {
			const pkgPath = Bun.resolveSync(
				`${platformPkg}/package.json`,
				import.meta.dir,
			);
			const pkgDir = dirname(pkgPath);
			const astGrepName = platform === "win32" ? "ast-grep.exe" : "ast-grep";
			const binaryPath = joinPath(pkgDir, astGrepName);

			if (isValidBinary(binaryPath)) {
				return binaryPath;
			}
		} catch {
			// Platform-specific package not installed
		}
	}

	if (platform === "darwin") {
		const homebrewPaths = ["/opt/homebrew/bin/sg", "/usr/local/bin/sg"];
		for (const path of homebrewPaths) {
			if (isValidBinary(path)) {
				return path;
			}
		}
	}

	return null;
}

let resolvedCliPath: string | null = null;

export function getSgCliPath(): string {
	if (resolvedCliPath !== null) {
		return resolvedCliPath;
	}

	const syncPath = findSgCliPathSync();
	if (syncPath) {
		resolvedCliPath = syncPath;
		return syncPath;
	}

	return "sg";
}

export function setSgCliPath(path: string): void {
	resolvedCliPath = path;
}

// CLI supported languages (25 total)
export const CLI_LANGUAGES = [
	"bash",
	"c",
	"cpp",
	"csharp",
	"css",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"nix",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"solidity",
	"swift",
	"typescript",
	"tsx",
	"yaml",
] as const;

// NAPI supported languages (5 total - native bindings)
export const NAPI_LANGUAGES = [
	"html",
	"javascript",
	"tsx",
	"css",
	"typescript",
] as const;

// Timeouts and limits
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_MATCHES = 500;

// Language to file extensions mapping
export const LANG_EXTENSIONS: Record<string, string[]> = {
	bash: [".bash", ".sh", ".zsh", ".bats"],
	c: [".c", ".h"],
	cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".h"],
	csharp: [".cs"],
	css: [".css"],
	elixir: [".ex", ".exs"],
	go: [".go"],
	haskell: [".hs", ".lhs"],
	html: [".html", ".htm"],
	java: [".java"],
	javascript: [".js", ".jsx", ".mjs", ".cjs"],
	json: [".json"],
	kotlin: [".kt", ".kts"],
	lua: [".lua"],
	nix: [".nix"],
	php: [".php"],
	python: [".py", ".pyi"],
	ruby: [".rb", ".rake"],
	rust: [".rs"],
	scala: [".scala", ".sc"],
	solidity: [".sol"],
	swift: [".swift"],
	typescript: [".ts", ".cts", ".mts"],
	tsx: [".tsx"],
	yaml: [".yml", ".yaml"],
};

export interface EnvironmentCheckResult {
	cli: {
		available: boolean;
		path: string;
		error?: string;
	};
	napi: {
		available: boolean;
		error?: string;
	};
}

/**
 * Check if ast-grep CLI and NAPI are available.
 * Call this at startup to provide early feedback about missing dependencies.
 */
export function checkEnvironment(): EnvironmentCheckResult {
	const cliPath = getSgCliPath();
	const result: EnvironmentCheckResult = {
		cli: {
			available: false,
			path: cliPath,
		},
		napi: {
			available: false,
		},
	};

	if (Bun.file(cliPath).size > 0) {
		result.cli.available = true;
	} else if (cliPath === "sg") {
		const resolvedCli = Bun.which("sg");
		result.cli.available = typeof resolvedCli === "string";
		if (result.cli.available && resolvedCli) {
			result.cli.path = resolvedCli;
		} else {
			result.cli.error = "sg binary not found in PATH";
		}
	} else {
		result.cli.error = `Binary not found: ${cliPath}`;
	}

	// Check NAPI availability
	try {
		Bun.resolveSync("@ast-grep/napi", import.meta.dir);
		result.napi.available = true;
	} catch (e) {
		result.napi.available = false;
		result.napi.error = `@ast-grep/napi not installed: ${e instanceof Error ? e.message : String(e)}`;
	}

	return result;
}

/**
 * Format environment check result as user-friendly message.
 */
export function formatEnvironmentCheck(result: EnvironmentCheckResult): string {
	const lines: string[] = ["ast-grep Environment Status:", ""];

	// CLI status
	if (result.cli.available) {
		lines.push(`✓ CLI: Available (${result.cli.path})`);
	} else {
		lines.push(`✗ CLI: Not available`);
		if (result.cli.error) {
			lines.push(`  Error: ${result.cli.error}`);
		}
		lines.push(`  Install: bun add -D @ast-grep/cli`);
	}

	// NAPI status
	if (result.napi.available) {
		lines.push(`✓ NAPI: Available`);
	} else {
		lines.push(`✗ NAPI: Not available`);
		if (result.napi.error) {
			lines.push(`  Error: ${result.napi.error}`);
		}
		lines.push(`  Install: bun add -D @ast-grep/napi`);
	}

	lines.push("");
	lines.push(`CLI supports ${CLI_LANGUAGES.length} languages`);
	lines.push(
		`NAPI supports ${NAPI_LANGUAGES.length} languages: ${NAPI_LANGUAGES.join(", ")}`,
	);

	return lines.join("\n");
}
