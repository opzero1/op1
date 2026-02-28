import { joinPath, runtimePlatform } from "./bun-utils";
import {
	ensureDirectory,
	existingBinary,
	getLspBinDir,
	isLspDownloadDisabled,
	makeExecutable,
} from "./installer-utils";
import { extractTarGz, extractZip } from "./zip-extractor";

const TINYMIST_RELEASE_URL =
	"https://api.github.com/repos/Myriad-Dreamin/tinymist/releases/latest";

interface GitHubRelease {
	assets?: Array<{
		name?: string;
		browser_download_url?: string;
	}>;
}

type TinymistArchive = "zip" | "tar.gz";

function getTinymistArch(): "x86_64" | "aarch64" | null {
	if (process.arch === "arm64") return "aarch64";
	if (process.arch === "x64") return "x86_64";
	return null;
}

function getTinymistTarget():
	| { target: "apple-darwin"; archive: "tar.gz" }
	| { target: "pc-windows-msvc"; archive: "zip" }
	| { target: "unknown-linux-gnu"; archive: "tar.gz" } {
	const platform = runtimePlatform();
	if (platform === "darwin") {
		return { target: "apple-darwin", archive: "tar.gz" };
	}
	if (platform === "win32") {
		return { target: "pc-windows-msvc", archive: "zip" };
	}
	return { target: "unknown-linux-gnu", archive: "tar.gz" };
}

function getBinaryName(): string {
	return runtimePlatform() === "win32" ? "tinymist.exe" : "tinymist";
}

function getAssetName(): string | null {
	const arch = getTinymistArch();
	if (!arch) return null;

	const target = getTinymistTarget();
	return `tinymist-${arch}-${target.target}.${target.archive}`;
}

async function getExistingBinaryPath(): Promise<string | null> {
	return existingBinary(joinPath(getLspBinDir(), getBinaryName()));
}

export function canAutoInstallTinymist(): boolean {
	return !isLspDownloadDisabled() && getTinymistArch() !== null;
}

export async function ensureTinymistBinary(): Promise<string | null> {
	const existing = await getExistingBinaryPath();
	if (existing) return existing;
	if (!canAutoInstallTinymist()) return null;

	try {
		const binDir = getLspBinDir();
		const ensured = await ensureDirectory(binDir);
		if (!ensured) return null;

		const releaseResponse = await fetch(TINYMIST_RELEASE_URL);
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
			const archiveType: TinymistArchive = getTinymistTarget().archive;
			if (archiveType === "zip") {
				await extractZip(archivePath, binDir);
			} else {
				await extractTarGz(archivePath, binDir, 1);
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
