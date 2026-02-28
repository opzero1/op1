import { spawn } from "bun";
import { homeDirectory, joinPath, runtimePlatform } from "./bun-utils";

export function isLspDownloadDisabled(): boolean {
	const value = Bun.env.OPENCODE_DISABLE_LSP_DOWNLOAD;
	if (!value) return false;

	const normalized = value.toLowerCase();
	return normalized !== "0" && normalized !== "false";
}

export function getLspBinDir(): string {
	return joinPath(homeDirectory(), ".config", "opencode", "bin");
}

export async function ensureDirectory(path: string): Promise<boolean> {
	if (await Bun.file(path).exists()) return true;

	const command =
		runtimePlatform() === "win32"
			? ["cmd", "/c", "mkdir", path]
			: ["mkdir", "-p", path];

	const proc = spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	});

	const exitCode = await proc.exited;
	if (exitCode === 0) return true;

	return Bun.file(path).exists();
}

export async function makeExecutable(path: string): Promise<void> {
	if (runtimePlatform() === "win32") return;

	Bun.spawnSync(["chmod", "755", path], {
		stdout: "ignore",
		stderr: "ignore",
	});
}

export async function existingBinary(path: string): Promise<string | null> {
	const file = Bun.file(path);
	if ((await file.exists()) && file.size > 0) {
		return path;
	}

	return null;
}
