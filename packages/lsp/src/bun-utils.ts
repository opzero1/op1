/**
 * Bun-first path and file utilities.
 */

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

function detectPlatformLabel(
	value: string | undefined,
): "win32" | "darwin" | "linux" | null {
	const normalized = (value || "").trim().toLowerCase();
	if (!normalized) return null;
	if (normalized.includes("darwin") || normalized.includes("mac")) {
		return "darwin";
	}
	if (
		normalized === "win32" ||
		normalized.includes("windows") ||
		normalized.includes("cygwin") ||
		normalized.includes("mingw") ||
		normalized.includes("msys")
	) {
		return "win32";
	}
	if (normalized.includes("linux")) return "linux";
	return null;
}

export function runtimePlatform(): "win32" | "darwin" | "linux" {
	return (
		detectPlatformLabel(process.platform) ||
		detectPlatformLabel(Bun.env.OS || Bun.env.OSTYPE) ||
		detectPlatformLabel(
			typeof navigator === "object" ? navigator.platform : "",
		) ||
		"linux"
	);
}

export function currentWorkingDirectory(): string {
	const pwd = Bun.env.PWD;
	if (typeof pwd === "string" && pwd.length > 0) {
		return pwd;
	}
	return ".";
}

function isWindowsPath(path: string): boolean {
	return WINDOWS_DRIVE_PREFIX.test(path);
}

function isAbsolutePath(path: string): boolean {
	if (path.startsWith("/")) return true;
	if (path.startsWith("\\\\")) return true;
	return isWindowsPath(path);
}

export function normalizePath(input: string): string {
	if (!input) return currentWorkingDirectory();

	const isWindows = runtimePlatform() === "win32";
	const hasUncPrefix = input.startsWith("\\\\");
	const base = input.replace(/\\/g, "/");

	let prefix = "";
	let body = base;

	if (WINDOWS_DRIVE_PREFIX.test(body)) {
		prefix = body.slice(0, 2);
		body = body.slice(2);
	} else if (body.startsWith("/")) {
		prefix = "/";
	}

	const parts = body.split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (stack.length > 0 && stack[stack.length - 1] !== "..") {
				stack.pop();
			} else if (!prefix) {
				stack.push("..");
			}
			continue;
		}
		stack.push(part);
	}

	const joined = stack.join("/");
	let normalized =
		prefix +
		(joined ? (prefix && !prefix.endsWith("/") ? "/" : "") + joined : "");

	if (!normalized) {
		normalized = prefix || ".";
	}

	if (hasUncPrefix && !normalized.startsWith("//")) {
		normalized = `//${normalized.replace(/^\/+/, "")}`;
	}

	if (isWindows) {
		if (normalized.startsWith("//")) {
			return normalized.replace(/\//g, "\\");
		}
		return normalized.replace(/\//g, "\\");
	}

	return normalized;
}

export function resolvePath(
	path: string,
	from = currentWorkingDirectory(),
): string {
	if (isAbsolutePath(path)) return normalizePath(path);
	return normalizePath(`${from}/${path}`);
}

export function dirname(path: string): string {
	const normalized = normalizePath(path).replace(/[\\/]+$/, "");
	if (!normalized) return runtimePlatform() === "win32" ? "." : "/";

	const slashIndex = Math.max(
		normalized.lastIndexOf("/"),
		normalized.lastIndexOf("\\"),
	);
	if (slashIndex === -1) return ".";
	if (slashIndex === 0) return normalized[0] === "\\" ? "\\" : "/";
	if (slashIndex === 2 && WINDOWS_DRIVE_PREFIX.test(normalized)) {
		return normalized.slice(0, 3);
	}
	return normalized.slice(0, slashIndex);
}

export function joinPath(...parts: string[]): string {
	if (parts.length === 0) return ".";
	const [first, ...rest] = parts;
	let current = first;
	for (const part of rest) {
		if (!part) continue;
		current = `${current.replace(/[\\/]+$/, "")}/${part.replace(/^[\\/]+/, "")}`;
	}
	return normalizePath(current);
}

export function extname(path: string): string {
	const normalized = normalizePath(path);
	const slashIndex = Math.max(
		normalized.lastIndexOf("/"),
		normalized.lastIndexOf("\\"),
	);
	const fileName =
		slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex <= 0) return "";
	return fileName.slice(dotIndex);
}

export function homeDirectory(): string {
	const home = Bun.env.HOME || Bun.env.USERPROFILE;
	if (home) return normalizePath(home);
	return currentWorkingDirectory();
}

export function pathToFileUri(path: string): string {
	const absolute = resolvePath(path);
	const unixPath = absolute.replace(/\\/g, "/");
	const pathname = isWindowsPath(unixPath) ? `/${unixPath}` : unixPath;
	const isWindowsDrivePath = isWindowsPath(unixPath);
	const encoded = pathname
		.split("/")
		.map((segment, index) => {
			if (index === 0) return segment;
			if (
				isWindowsDrivePath &&
				index === 1 &&
				WINDOWS_DRIVE_PREFIX.test(segment)
			) {
				return segment;
			}
			return encodeURIComponent(segment);
		})
		.join("/");
	return `file://${encoded}`;
}

export function fileUriToPath(uri: string): string {
	const url = new URL(uri);
	if (url.protocol !== "file:") {
		throw new Error(`Expected file:// URI, received: ${uri}`);
	}

	const pathname = decodeURIComponent(url.pathname);
	if (runtimePlatform() === "win32") {
		if (
			pathname.startsWith("/") &&
			WINDOWS_DRIVE_PREFIX.test(pathname.slice(1))
		) {
			return pathname.slice(1).replace(/\//g, "\\");
		}
		if (url.hostname) {
			return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
		}
		return pathname.replace(/\//g, "\\");
	}

	return pathname;
}
