import { joinPath, runtimePlatform } from "./bun-utils";
import {
	ensureDirectory,
	existingBinary,
	getLspBinDir,
	isLspDownloadDisabled,
	makeExecutable,
} from "./installer-utils";
import { extractZip } from "./zip-extractor";

const TERRAFORM_LS_RELEASE_URL =
	"https://api.releases.hashicorp.com/v1/releases/terraform-ls/latest";

interface TerraformRelease {
	builds?: Array<{
		arch?: string;
		os?: string;
		url?: string;
	}>;
}

function getBinaryName(): string {
	return runtimePlatform() === "win32" ? "terraform-ls.exe" : "terraform-ls";
}

function mapTerraformOS(): "windows" | "darwin" | "linux" {
	const platform = runtimePlatform();
	if (platform === "win32") return "windows";
	if (platform === "darwin") return "darwin";
	return "linux";
}

function mapTerraformArch(): "amd64" | "arm64" | null {
	if (process.arch === "arm64") return "arm64";
	if (process.arch === "x64") return "amd64";
	return null;
}

export function canAutoInstallTerraformLs(): boolean {
	return !isLspDownloadDisabled() && mapTerraformArch() !== null;
}

async function getExistingBinaryPath(): Promise<string | null> {
	const binaryPath = joinPath(getLspBinDir(), getBinaryName());
	return existingBinary(binaryPath);
}

export async function ensureTerraformLsBinary(): Promise<string | null> {
	const existingBinary = await getExistingBinaryPath();
	if (existingBinary) return existingBinary;
	if (!canAutoInstallTerraformLs()) return null;

	try {
		const arch = mapTerraformArch();
		if (!arch) return null;

		const os = mapTerraformOS();
		const binDir = getLspBinDir();
		const ensured = await ensureDirectory(binDir);
		if (!ensured) return null;

		const releaseResponse = await fetch(TERRAFORM_LS_RELEASE_URL);
		if (!releaseResponse.ok) return null;

		const release = (await releaseResponse.json()) as TerraformRelease;
		const build = release.builds?.find(
			(item) =>
				item.os === os && item.arch === arch && typeof item.url === "string",
		);
		if (!build?.url) return null;

		const archiveResponse = await fetch(build.url, { redirect: "follow" });
		if (!archiveResponse.ok) return null;

		const archivePath = joinPath(binDir, `terraform-ls-${os}-${arch}.zip`);
		await Bun.write(archivePath, await archiveResponse.arrayBuffer());

		try {
			await extractZip(archivePath, binDir);
		} finally {
			const archiveFile = Bun.file(archivePath);
			if (await archiveFile.exists()) {
				await archiveFile.unlink();
			}
		}

		const binaryPath = await getExistingBinaryPath();
		if (!binaryPath) return null;

		await makeExecutable(binaryPath);

		return binaryPath;
	} catch {
		return null;
	}
}
