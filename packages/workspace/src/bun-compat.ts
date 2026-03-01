type SystemError = Error & { code: string };

const IS_WINDOWS =
	(Bun.env.OS || "").toLowerCase().includes("win") ||
	(typeof navigator === "object" &&
		navigator.platform.toLowerCase().includes("win"));

function createSystemError(message: string, code: string): SystemError {
	const error = new Error(message) as SystemError;
	error.code = code;
	return error;
}

function splitPath(input: string): string[] {
	return input.split("/").filter((segment) => segment.length > 0);
}

function normalizeSegments(segments: string[], absolute: boolean): string[] {
	const stack: string[] = [];

	for (const segment of segments) {
		if (segment === "." || segment.length === 0) continue;
		if (segment === "..") {
			if (stack.length > 0 && stack[stack.length - 1] !== "..") {
				stack.pop();
				continue;
			}

			if (!absolute) {
				stack.push("..");
			}
			continue;
		}

		stack.push(segment);
	}

	return stack;
}

function normalizePath(input: string): string {
	if (input.length === 0) return ".";

	const absolute = input.startsWith("/");
	const segments = normalizeSegments(splitPath(input), absolute);

	if (absolute) {
		return segments.length === 0 ? "/" : `/${segments.join("/")}`;
	}

	return segments.length === 0 ? "." : segments.join("/");
}

export function join(...parts: string[]): string {
	if (parts.length === 0) return ".";

	let joined = "";
	for (const part of parts) {
		if (!part) continue;
		if (part.startsWith("/")) {
			joined = part;
			continue;
		}

		if (!joined || joined.endsWith("/")) {
			joined += part;
		} else {
			joined += `/${part}`;
		}
	}

	return normalizePath(joined || ".");
}

export function resolve(...parts: string[]): string {
	let resolved = Bun.env.PWD || ".";

	for (const part of parts) {
		if (!part) continue;
		resolved = part.startsWith("/") ? part : join(resolved, part);
	}

	return normalizePath(resolved);
}

export function relative(from: string, to: string): string {
	const fromResolved = resolve(from);
	const toResolved = resolve(to);

	if (fromResolved === toResolved) return ".";

	const fromSegments = splitPath(fromResolved);
	const toSegments = splitPath(toResolved);

	let index = 0;
	while (
		index < fromSegments.length &&
		index < toSegments.length &&
		fromSegments[index] === toSegments[index]
	) {
		index += 1;
	}

	const upward = new Array(fromSegments.length - index).fill("..");
	const downward = toSegments.slice(index);
	const output = [...upward, ...downward].join("/");

	return output || ".";
}

export function basename(pathValue: string, ext?: string): string {
	const normalized = normalizePath(pathValue).replace(/\/+$/g, "");
	const segments = splitPath(normalized);
	const name =
		segments[segments.length - 1] || (normalized.startsWith("/") ? "/" : "");

	if (!ext) return name;
	return name.endsWith(ext) ? name.slice(0, -ext.length) : name;
}

export function dirname(pathValue: string): string {
	const normalized = normalizePath(pathValue).replace(/\/+$/g, "");
	if (normalized === "/") return "/";

	const segments = splitPath(normalized);
	if (segments.length <= 1) return normalized.startsWith("/") ? "/" : ".";

	const dir = segments.slice(0, -1).join("/");
	return normalized.startsWith("/") ? `/${dir}` : dir;
}

export function homedir(): string {
	return Bun.env.HOME || "/";
}

export function tmpdir(): string {
	return Bun.env.TMPDIR || "/tmp";
}

async function runSystemCommand(command: string[]): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	const proc = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, stdout, stderr };
}

async function ensureDirectory(pathValue: string): Promise<void> {
	const marker = join(
		pathValue,
		`.op1-mkdir-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

export async function mkdir(
	pathValue: string,
	options?: { recursive?: boolean },
): Promise<void> {
	if (!options?.recursive) {
		const exists = await Bun.file(pathValue).exists();
		if (exists) {
			throw createSystemError(
				`EEXIST: file already exists, mkdir '${pathValue}'`,
				"EEXIST",
			);
		}
	}

	await ensureDirectory(pathValue);
}

export async function rm(
	pathValue: string,
	options?: { recursive?: boolean; force?: boolean },
): Promise<void> {
	const file = Bun.file(pathValue);
	if (await file.exists()) {
		await file.delete();
		return;
	}

	if (!options?.recursive) {
		if (options?.force) return;
		throw createSystemError(
			`ENOENT: no such file or directory, unlink '${pathValue}'`,
			"ENOENT",
		);
	}

	const command = IS_WINDOWS
		? ["cmd", "/c", "rmdir", "/s", "/q", pathValue]
		: ["rm", options?.force ? "-rf" : "-r", pathValue];
	const result = await runSystemCommand(command);
	if (result.code === 0 || options?.force) return;
	throw new Error(result.stderr.trim() || `rm failed for ${pathValue}`);
}

export async function mkdtemp(prefix: string): Promise<string> {
	const parent = dirname(prefix);
	await mkdir(parent, { recursive: true });

	for (let attempt = 0; attempt < 100; attempt += 1) {
		const suffix = Math.random().toString(36).slice(2, 10);
		const pathValue = `${prefix}${suffix}`;
		try {
			await mkdir(pathValue);
			return pathValue;
		} catch {
			// retry
		}
	}

	throw new Error(`mkdtemp failed for prefix ${prefix}`);
}

export async function readdir(pathValue: string): Promise<string[]> {
	const entries: string[] = [];
	try {
		for await (const entry of new Bun.Glob("*").scan({
			cwd: pathValue,
			onlyFiles: false,
		})) {
			entries.push(entry);
		}
	} catch {
		throw createSystemError(
			`ENOENT: no such file or directory, scandir '${pathValue}'`,
			"ENOENT",
		);
	}

	return entries;
}

export async function copyFile(
	source: string,
	destination: string,
): Promise<void> {
	if (!(await Bun.file(source).exists())) {
		throw createSystemError(
			`ENOENT: no such file or directory, copyfile '${source}'`,
			"ENOENT",
		);
	}

	const sourceFile = Bun.file(source);
	await mkdir(dirname(destination), { recursive: true });
	await Bun.write(destination, sourceFile);
}

export async function symlink(
	target: string,
	pathValue: string,
): Promise<void> {
	const targetStat = await stat(target).catch(() => null);
	const result = await runSystemCommand(
		IS_WINDOWS
			? [
					"cmd",
					"/c",
					"mklink",
					...(targetStat?.isDirectory() ? ["/D"] : []),
					pathValue,
					target,
				]
			: ["ln", "-s", target, pathValue],
	);
	if (result.code === 0) return;

	if (
		result.stderr.includes("File exists") ||
		result.stderr.includes("Cannot create a file when that file already exists")
	) {
		throw createSystemError(
			`EEXIST: file already exists, symlink '${pathValue}'`,
			"EEXIST",
		);
	}

	throw new Error(result.stderr.trim() || `symlink failed for ${pathValue}`);
}

export async function unlink(pathValue: string): Promise<void> {
	const file = Bun.file(pathValue);
	if (!(await file.exists())) {
		throw createSystemError(
			`ENOENT: no such file or directory, unlink '${pathValue}'`,
			"ENOENT",
		);
	}
	await file.delete();
}

export async function writeFile(
	pathValue: string,
	data: string,
	options?: { flag?: "w" | "wx" },
): Promise<void> {
	if (options?.flag === "wx") {
		if (await Bun.file(pathValue).exists()) {
			throw createSystemError(
				`EEXIST: file already exists, open '${pathValue}'`,
				"EEXIST",
			);
		}
	}

	await mkdir(dirname(pathValue), { recursive: true });
	await Bun.write(pathValue, data);
}

export async function stat(pathValue: string): Promise<{
	isDirectory(): boolean;
	isFile(): boolean;
	mtimeMs: number;
}> {
	const file = Bun.file(pathValue);
	if (await file.exists()) {
		return {
			isDirectory: () => false,
			isFile: () => true,
			mtimeMs: file.lastModified,
		};
	}

	try {
		for await (const _entry of new Bun.Glob("*").scan({
			cwd: pathValue,
			onlyFiles: false,
		})) {
			break;
		}
		return {
			isDirectory: () => true,
			isFile: () => false,
			mtimeMs: 0,
		};
	} catch {
		throw createSystemError(
			`ENOENT: no such file or directory, stat '${pathValue}'`,
			"ENOENT",
		);
	}
}
