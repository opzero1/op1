import { joinPath, runtimePlatform } from "./bun-utils";
import {
	ensureDirectory,
	existingBinary,
	getLspBinDir,
	isLspDownloadDisabled,
	makeExecutable,
} from "./installer-utils";
import { extractTarGz, extractZip } from "./zip-extractor";

const TEXLAB_RELEASE_URL =
	"https://api.github.com/repos/latex-lsp/texlab/releases/latest";

interface GitHubRelease {
	assets?: Array<{
		name?: string;
		browser_download_url?: string;
	}>;
}

type TexlabArchive = "zip" | "tar.gz";

function getTexlabArch(): "x86_64" | "aarch64" | null {
	if (process.arch === "arm64") return "aarch64";
	if (process.arch === "x64") return "x86_64";
	return null;
}

function getTexlabPlatform(): "macos" | "windows" | "linux" {
	const platform = runtimePlatform();
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	return "linux";
}

function getArchiveType(): TexlabArchive {
	return runtimePlatform() === "win32" ? "zip" : "tar.gz";
}

function getBinaryName(): string {
	return runtimePlatform() === "win32" ? "texlab.exe" : "texlab";
}

function getAssetName(): string | null {
	const arch = getTexlabArch();
	if (!arch) return null;

	const platform = getTexlabPlatform();
	const archive = getArchiveType();
	return `texlab-${arch}-${platform}.${archive}`;
}

async function getExistingBinaryPath(): Promise<string | null> {
	return existingBinary(joinPath(getLspBinDir(), getBinaryName()));
}

export function canAutoInstallTexlab(): boolean {
	return !isLspDownloadDisabled() && getTexlabArch() !== null;
}

export async function ensureTexlabBinary(): Promise<string | null> {
	const existing = await getExistingBinaryPath();
	if (existing) return existing;
	if (!canAutoInstallTexlab()) return null;

	try {
		const binDir = getLspBinDir();
		const ensured = await ensureDirectory(binDir);
		if (!ensured) return null;

		const releaseResponse = await fetch(TEXLAB_RELEASE_URL);
		if (!releaseResponse.ok) return null;

		const release = (await releaseResponse.json()) as GitHubRelease;
		const assetName = getAssetName();
		if (!assetName) return null;

		const asset = release.assets?.find(
			(item) =>
				item.name === assetName &&
				typeof item.browser_download_url === "string",
		);
		if (!asset?.browser_download_url) return null;

		const archiveResponse = await fetch(asset.browser_download_url, {
			redirect: "follow",
		});
		if (!archiveResponse.ok) return null;

		const archivePath = joinPath(binDir, assetName);
		await Bun.write(archivePath, await archiveResponse.arrayBuffer());

		try {
			if (getArchiveType() === "zip") {
				await extractZip(archivePath, binDir);
			} else {
				await extractTarGz(archivePath, binDir);
			}
		} finally {
			const archiveFile = Bun.file(archivePath);
			if (await archiveFile.exists()) {
				await archiveFile.unlink();
			}
		}

		const binary = await getExistingBinaryPath();
		if (!binary) return null;

		await makeExecutable(binary);
		return binary;
	} catch {
		return null;
	}
}
