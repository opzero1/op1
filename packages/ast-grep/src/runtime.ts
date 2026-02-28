type RuntimePlatform = "darwin" | "linux" | "win32" | "unsupported";

function normalizeLabel(input: string | undefined): string {
	return (input || "").trim().toLowerCase();
}

function detectPlatform(label: string): RuntimePlatform {
	if (!label) return "unsupported";
	if (label.includes("darwin") || label.includes("mac")) return "darwin";
	if (
		label === "win32" ||
		label.includes("windows") ||
		label.includes("cygwin") ||
		label.includes("mingw") ||
		label.includes("msys")
	)
		return "win32";
	if (label.includes("linux")) return "linux";
	return "unsupported";
}

function readCommandOutput(command: string[]): string {
	const result = Bun.spawnSync(command, {
		stdout: "pipe",
		stderr: "ignore",
	});

	if (result.exitCode !== 0) return "";
	return new TextDecoder().decode(result.stdout).trim().toLowerCase();
}

export function runtimePlatform(): RuntimePlatform {
	const processPlatform = detectPlatform(normalizeLabel(process.platform));
	if (processPlatform !== "unsupported") return processPlatform;

	const envPlatform = detectPlatform(
		normalizeLabel(Bun.env.OS || Bun.env.OSTYPE),
	);
	if (envPlatform !== "unsupported") return envPlatform;

	const navigatorPlatform = detectPlatform(
		normalizeLabel(typeof navigator === "object" ? navigator.platform : ""),
	);
	if (navigatorPlatform !== "unsupported") return navigatorPlatform;

	const uname = readCommandOutput(["uname", "-s"]);
	return detectPlatform(uname);
}

function mapArch(raw: string): string {
	const normalized = normalizeLabel(raw).replace(/\s+/g, "");
	if (normalized === "x86_64" || normalized === "amd64") return "x64";
	if (normalized === "aarch64" || normalized === "arm64") return "arm64";
	if (normalized === "i386" || normalized === "i686" || normalized === "x86") {
		return "ia32";
	}
	return normalized || "x64";
}

export function runtimeArch(): string {
	if (process.arch) {
		return mapArch(process.arch);
	}

	const envArch =
		Bun.env.PROCESSOR_ARCHITECTURE || Bun.env.HOSTTYPE || Bun.env.MACHTYPE;
	if (envArch) return mapArch(envArch);

	const unameArch = readCommandOutput(["uname", "-m"]);
	if (unameArch) return mapArch(unameArch);

	return "x64";
}

export function homeDirectory(): string {
	return (
		Bun.env.HOME ||
		Bun.env.USERPROFILE ||
		(Bun.env.HOMEDRIVE && Bun.env.HOMEPATH
			? `${Bun.env.HOMEDRIVE}${Bun.env.HOMEPATH}`
			: undefined) ||
		"/tmp"
	);
}
