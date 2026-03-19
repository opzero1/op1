import { relative, resolve } from "node:path";

const CHARS_PER_TOKEN = 4;

const TEXT_FILE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cs",
	".css",
	".go",
	".h",
	".hpp",
	".html",
	".java",
	".js",
	".json",
	".jsx",
	".kt",
	".md",
	".mjs",
	".php",
	".py",
	".rb",
	".rs",
	".scala",
	".sh",
	".sql",
	".swift",
	".toml",
	".ts",
	".tsx",
	".txt",
	".xml",
	".yaml",
	".yml",
]);

export function estimateTokens(value: string): number {
	return Math.max(1, Math.ceil(value.length / CHARS_PER_TOKEN));
}

export function hashText(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

export function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

export function toWorkspacePath(root: string, value: string): string {
	return normalizePath(relative(resolve(root), resolve(value)));
}

export function isTextLikePath(value: string): boolean {
	const normalized = value.toLowerCase();
	const lastDot = normalized.lastIndexOf(".");
	if (lastDot === -1) return false;
	return TEXT_FILE_EXTENSIONS.has(normalized.slice(lastDot));
}

export function splitLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export async function runCommand(
	command: string[],
	cwd: string,
): Promise<string | null> {
	const proc = Bun.spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		return null;
	}
	return stdout.trimEnd();
}

export async function readTextFile(path: string): Promise<string | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	if (!file.type.startsWith("text/") && !isTextLikePath(path)) {
		return null;
	}
	return file.text();
}

export function withLineNumbers(lines: string[], startLine: number): string {
	return lines
		.map((line, index) => `${startLine + index}: ${line}`)
		.join("\n")
		.trim();
}

export function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	if (maxChars <= 3) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - 3)}...`;
}
