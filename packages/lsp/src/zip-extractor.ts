import { spawn } from "bun";
import { runtimePlatform } from "./bun-utils";

function isPwshAvailable(): boolean {
	if (runtimePlatform() !== "win32") return false;
	return typeof Bun.which("pwsh") === "string";
}

function escapePowerShellPath(path: string): string {
	return path.replace(/'/g, "''");
}

type WindowsZipExtractor = "tar" | "pwsh" | "powershell";

function getWindowsZipExtractor(): WindowsZipExtractor {
	if (typeof Bun.which("tar") === "string") {
		return "tar";
	}

	if (isPwshAvailable()) {
		return "pwsh";
	}

	return "powershell";
}

export async function extractZip(
	archivePath: string,
	destDir: string,
): Promise<void> {
	let proc: {
		exited: Promise<number>;
		stderr?: ReadableStream<Uint8Array> | null;
	};

	if (runtimePlatform() === "win32") {
		const extractor = getWindowsZipExtractor();

		switch (extractor) {
			case "tar":
				proc = spawn(["tar", "-xf", archivePath, "-C", destDir], {
					stdout: "ignore",
					stderr: "pipe",
				});
				break;
			case "pwsh":
				proc = spawn(
					[
						"pwsh",
						"-Command",
						`Expand-Archive -Path '${escapePowerShellPath(archivePath)}' -DestinationPath '${escapePowerShellPath(destDir)}' -Force`,
					],
					{
						stdout: "ignore",
						stderr: "pipe",
					},
				);
				break;
			default:
				proc = spawn(
					[
						"powershell",
						"-Command",
						`Expand-Archive -Path '${escapePowerShellPath(archivePath)}' -DestinationPath '${escapePowerShellPath(destDir)}' -Force`,
					],
					{
						stdout: "ignore",
						stderr: "pipe",
					},
				);
				break;
		}
	} else {
		proc = spawn(["unzip", "-o", archivePath, "-d", destDir], {
			stdout: "ignore",
			stderr: "pipe",
		});
	}

	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
		throw new Error(`zip extraction failed (exit ${exitCode}): ${stderr}`);
	}
}

export async function extractTarGz(
	archivePath: string,
	destDir: string,
	stripComponents = 0,
): Promise<void> {
	const args = ["tar", "-xzf", archivePath, "-C", destDir];
	if (stripComponents > 0) {
		args.push("--strip-components", String(stripComponents));
	}

	const proc = spawn(args, {
		stdout: "ignore",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
		throw new Error(`tar extraction failed (exit ${exitCode}): ${stderr}`);
	}
}
