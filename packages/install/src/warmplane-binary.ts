import { chmod, rename } from "node:fs/promises";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");

function toPosixPath(input: string): string {
	return input.replace(/\\+/g, "/");
}

function isAbsolutePath(input: string): boolean {
	if (input.startsWith("/")) {
		return true;
	}

	return /^[A-Za-z]:\//.test(input);
}

function toNativePath(input: string): string {
	if (!IS_WINDOWS) {
		return input;
	}

	return input.replace(/\//g, "\\");
}

function joinPath(...parts: string[]): string {
	const normalized = parts
		.filter((part) => part.length > 0)
		.map((part) => toPosixPath(part));

	if (normalized.length === 0) {
		return "";
	}

	let result = normalized[0];
	for (let index = 1; index < normalized.length; index += 1) {
		const part = normalized[index];
		if (isAbsolutePath(part)) {
			result = part;
			continue;
		}

		const left = result.replace(/\/+$/, "");
		const right = part.replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return toNativePath(result);
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const marker = joinPath(
		dirPath,
		`.op1-warmplane-bin-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

function hashBytes(input: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

async function atomicWriteBytes(
	filePath: string,
	content: Uint8Array,
): Promise<void> {
	const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	await Bun.write(tmpPath, content);
	await rename(tmpPath, filePath);
}

async function atomicWriteJson(
	filePath: string,
	content: unknown,
): Promise<void> {
	await atomicWriteBytes(
		filePath,
		new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`),
	);
}

type WarmplaneBinarySource = "local-override" | "release-download" | "path";

export interface WarmplaneBinaryRelease {
	version: string;
	platform: "darwin-arm64" | "darwin-x64";
	url: string;
	sha256?: string;
}

const DEFAULT_WARMPLANE_GITHUB_REPO = "opzero1/warmplane";

function buildWarmplaneGithubReleaseUrl(input: {
	repo: string;
	version: string;
	assetName: string;
}): string {
	return `https://github.com/${input.repo}/releases/download/v${input.version}/${input.assetName}`;
}

interface WarmplaneBinaryInstallMetadata {
	version?: string;
	platform: string;
	source: WarmplaneBinarySource;
	url?: string;
	sha256?: string;
	installed_at: string;
}

export interface EnsureWarmplaneBinaryOptions {
	homeDir: string;
	dryRun?: boolean;
	platform?: string;
	arch?: string;
	env?: Record<string, string | undefined>;
	resolveWhich?: (command: string) => string | null;
	fetchImpl?: FetchLike;
}

export interface EnsureWarmplaneBinaryResult {
	binaryPath: string;
	metadataPath?: string;
	status: "installed" | "reused" | "path" | "would_install";
	source: WarmplaneBinarySource;
	version?: string;
	platform: string;
	url?: string;
}

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit | BunFetchRequestInit,
) => Promise<Response>;

const DEFAULT_WARMPLANE_MAC_RELEASES: Record<
	"darwin-arm64" | "darwin-x64",
	WarmplaneBinaryRelease
> = {
	"darwin-arm64": {
		version: "0.1.1",
		platform: "darwin-arm64",
		url: buildWarmplaneGithubReleaseUrl({
			repo: DEFAULT_WARMPLANE_GITHUB_REPO,
			version: "0.1.1",
			assetName: "warmplane-aarch64-apple-darwin",
		}),
	},
	"darwin-x64": {
		version: "0.1.1",
		platform: "darwin-x64",
		url: buildWarmplaneGithubReleaseUrl({
			repo: DEFAULT_WARMPLANE_GITHUB_REPO,
			version: "0.1.1",
			assetName: "warmplane-x86_64-apple-darwin",
		}),
	},
};

export function resolveWarmplaneBinaryInstallDir(homeDir: string): string {
	return joinPath(homeDir, ".local", "share", "opencode", "bin");
}

export function resolveWarmplaneBinaryPath(homeDir: string): string {
	return joinPath(resolveWarmplaneBinaryInstallDir(homeDir), "warmplane");
}

export function resolveWarmplaneBinaryMetadataPath(homeDir: string): string {
	return joinPath(resolveWarmplaneBinaryInstallDir(homeDir), "warmplane.json");
}

export function resolveWarmplaneBinaryRelease(input?: {
	platform?: string;
	arch?: string;
	env?: Record<string, string | undefined>;
}): WarmplaneBinaryRelease | null {
	const platform = input?.platform ?? process.platform;
	const arch = input?.arch ?? process.arch;
	const env = input?.env ?? Bun.env;
	const releaseRepo =
		env.OP1_WARMPLANE_GITHUB_REPO || DEFAULT_WARMPLANE_GITHUB_REPO;

	if (platform !== "darwin") {
		return null;
	}

	const releasePlatform =
		arch === "arm64" ? "darwin-arm64" : arch === "x64" ? "darwin-x64" : null;
	if (releasePlatform === null) {
		return null;
	}

	const defaultRelease = DEFAULT_WARMPLANE_MAC_RELEASES[releasePlatform];
	const version = env.OP1_WARMPLANE_VERSION || defaultRelease.version;
	const defaultUrl = buildWarmplaneGithubReleaseUrl({
		repo: releaseRepo,
		version,
		assetName:
			releasePlatform === "darwin-arm64"
				? "warmplane-aarch64-apple-darwin"
				: "warmplane-x86_64-apple-darwin",
	});
	const url = env.OP1_WARMPLANE_BIN_URL || defaultUrl;
	const sha256 = env.OP1_WARMPLANE_BIN_SHA256 || defaultRelease.sha256;

	return {
		version,
		platform: releasePlatform,
		url,
		sha256,
	};
}

export function isWarmplaneBinaryRecommendedDefault(input?: {
	platform?: string;
	arch?: string;
	env?: Record<string, string | undefined>;
	resolveWhich?: (command: string) => string | null;
}): boolean {
	if (
		resolveWarmplaneBinaryRelease({
			platform: input?.platform,
			arch: input?.arch,
			env: input?.env,
		})
	) {
		return true;
	}

	const resolveWhich =
		input?.resolveWhich ?? ((command: string) => Bun.which(command));
	return resolveWhich("warmplane") !== null;
}

async function readInstallMetadata(
	metadataPath: string,
): Promise<WarmplaneBinaryInstallMetadata | null> {
	const file = Bun.file(metadataPath);
	if (!(await file.exists())) {
		return null;
	}

	try {
		const parsed = (await file.json()) as WarmplaneBinaryInstallMetadata;
		if (!parsed || typeof parsed !== "object") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

async function installBinaryFromBytes(input: {
	binaryPath: string;
	metadataPath: string;
	bytes: Uint8Array;
	platform: string;
	source: Exclude<WarmplaneBinarySource, "path">;
	version?: string;
	url?: string;
	sha256?: string;
	dryRun?: boolean;
}): Promise<EnsureWarmplaneBinaryResult> {
	if (input.dryRun) {
		return {
			binaryPath: input.binaryPath,
			metadataPath: input.metadataPath,
			status: "would_install",
			source: input.source,
			version: input.version,
			platform: input.platform,
			url: input.url,
		};
	}

	await atomicWriteBytes(input.binaryPath, input.bytes);
	await chmod(input.binaryPath, 0o755);
	await atomicWriteJson(input.metadataPath, {
		version: input.version,
		platform: input.platform,
		source: input.source,
		url: input.url,
		sha256: input.sha256,
		installed_at: new Date().toISOString(),
	} satisfies WarmplaneBinaryInstallMetadata);

	return {
		binaryPath: input.binaryPath,
		metadataPath: input.metadataPath,
		status: "installed",
		source: input.source,
		version: input.version,
		platform: input.platform,
		url: input.url,
	};
}

export async function ensureWarmplaneBinary(
	input: EnsureWarmplaneBinaryOptions,
): Promise<EnsureWarmplaneBinaryResult> {
	const env = input.env ?? Bun.env;
	const platform = input.platform ?? process.platform;
	const arch = input.arch ?? process.arch;
	const resolveWhich = input.resolveWhich ?? ((command) => Bun.which(command));
	const fetchImpl = input.fetchImpl ?? fetch;
	const binaryPath = resolveWarmplaneBinaryPath(input.homeDir);
	const metadataPath = resolveWarmplaneBinaryMetadataPath(input.homeDir);
	const binaryDir = resolveWarmplaneBinaryInstallDir(input.homeDir);
	const overrideBinaryPath = env.OP1_WARMPLANE_BIN_PATH;

	if (overrideBinaryPath) {
		const sourceFile = Bun.file(overrideBinaryPath);
		if (!(await sourceFile.exists())) {
			throw new Error(
				`Warmplane binary override path does not exist: ${overrideBinaryPath}`,
			);
		}

		const bytes = new Uint8Array(await sourceFile.arrayBuffer());
		const sha256 = hashBytes(bytes);
		await ensureDirectory(binaryDir);
		return installBinaryFromBytes({
			binaryPath,
			metadataPath,
			bytes,
			platform: `${platform}-${arch}`,
			source: "local-override",
			sha256,
			dryRun: input.dryRun,
		});
	}

	const release = resolveWarmplaneBinaryRelease({ platform, arch, env });
	if (release) {
		if (input.dryRun) {
			return {
				binaryPath,
				metadataPath,
				status: "would_install",
				source: "release-download",
				version: release.version,
				platform: release.platform,
				url: release.url,
			};
		}

		await ensureDirectory(binaryDir);
		const existingMetadata = await readInstallMetadata(metadataPath);
		if (
			existingMetadata?.source === "release-download" &&
			existingMetadata.version === release.version &&
			existingMetadata.url === release.url &&
			(await Bun.file(binaryPath).exists())
		) {
			return {
				binaryPath,
				metadataPath,
				status: "reused",
				source: "release-download",
				version: release.version,
				platform: release.platform,
				url: release.url,
			};
		}

		const response = await fetchImpl(release.url);
		if (!response.ok) {
			throw new Error(
				`Failed to download Warmplane mac binary from ${release.url} (${response.status} ${response.statusText})`,
			);
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		const sha256 = hashBytes(bytes);
		if (release.sha256 && sha256 !== release.sha256) {
			throw new Error(
				`Warmplane binary checksum mismatch. Expected ${release.sha256}, got ${sha256}`,
			);
		}

		return installBinaryFromBytes({
			binaryPath,
			metadataPath,
			bytes,
			platform: release.platform,
			source: "release-download",
			version: release.version,
			url: release.url,
			sha256,
			dryRun: input.dryRun,
		});
	}

	const existingPath = resolveWhich("warmplane");
	if (existingPath) {
		return {
			binaryPath: existingPath,
			status: "path",
			source: "path",
			platform: `${platform}-${arch}`,
		};
	}

	throw new Error(
		platform === "darwin"
			? `Warmplane mac prebuilt is not configured for architecture '${arch}'. Set OP1_WARMPLANE_BIN_PATH or install warmplane manually.`
			: `Warmplane prebuilt install is only implemented for macOS right now. Install warmplane manually on '${platform}-${arch}'.`,
	);
}
