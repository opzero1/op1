import { relative, resolve } from "../bun-compat.js";
import { extractPatternCandidates } from "../context-scout/extraction.js";
import type {
	ContextScoutStateManager,
	PatternSeverity,
	RankedPatternRecord,
} from "../context-scout/state.js";
import { createLogger } from "../logging.js";
import { redactText } from "../redaction.js";

const logger = createLogger("workspace.context-scout");

const EXTRACTION_TOOLS = new Set([
	"grep",
	"glob",
	"ast_grep_search",
	"ast_grep_replace",
	"lsp_symbols",
	"lsp_find_references",
	"lsp_goto_definition",
]);

const INJECTION_TOOLS = new Set(["plan_read", "plan_doc_load"]);

const DEFAULT_MAX_INJECTION_PATTERNS = 3;
const DEFAULT_INJECTION_TOKEN_BUDGET = 1200;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_MIN_SEVERITY: PatternSeverity = "medium";
const DEFAULT_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EXTRACTION_OUTPUT_CHARS = 120_000;

const PATH_TRUST_REQUIRED_SOURCES = new Set([
	"grep",
	"glob",
	"ast_grep",
	"lsp",
]);

const SENSITIVE_PATH_PATTERN =
	/(^|\/)(\.env(?:\..*)?|secrets?|credentials?|id_rsa|id_dsa|known_hosts)(\/|$)/i;
const SECRET_PATTERN =
	/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i;
const PRIVATE_KEY_PATTERN =
	/-----BEGIN\s+(?:RSA|EC|OPENSSH|PGP)\s+PRIVATE KEY-----/i;

interface ToolExecuteAfterInput {
	tool: string;
	sessionID: string;
	callID: string;
	args?: unknown;
}

interface ToolExecuteAfterOutput {
	title: string;
	output: string;
	metadata: unknown;
}

interface ContextScoutHookOptions {
	enabled?: boolean;
	stateManager: ContextScoutStateManager;
	workspaceRoot?: string;
	allowlistedRoots?: string[];
	allowedExtractionTools?: string[];
	allowedInjectionTools?: string[];
	maxInjectionPatterns?: number;
	maxInjectionTokens?: number;
	maxExtractionOutputChars?: number;
	freshnessWindowMs?: number;
	minConfidence?: number;
	minSeverity?: PatternSeverity;
	now?: () => number;
}

interface InjectionFormatterOptions {
	maxPatterns: number;
	maxTokens: number;
	minConfidence: number;
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase();
}

function isWindowsDriveAbsolutePath(pathValue: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(pathValue);
}

function isWindowsUncPath(pathValue: string): boolean {
	return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(pathValue);
}

function normalizePathSegments(pathValue: string): string {
	const absolute = pathValue.startsWith("/");
	const segments = pathValue.split("/");
	const normalized: string[] = [];

	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (normalized.length > 0 && normalized[normalized.length - 1] !== "..") {
				normalized.pop();
				continue;
			}

			if (!absolute) {
				normalized.push("..");
			}
			continue;
		}

		normalized.push(segment);
	}

	if (absolute) {
		return `/${normalized.join("/")}`;
	}

	return normalized.join("/");
}

function normalizeUnixAbsolute(pathValue: string): string {
	const normalized = normalizePathSegments(pathValue.replace(/\\/g, "/"));
	return normalized === "" ? "/" : normalized;
}

function normalizeWindowsDriveAbsolute(pathValue: string): string | null {
	if (!isWindowsDriveAbsolutePath(pathValue)) return null;
	const drive = pathValue[0]?.toUpperCase();
	if (!drive) return null;
	const rest = pathValue.slice(2).replace(/\\/g, "/").replace(/^\/+/, "");
	const normalizedRest = normalizePathSegments(`/${rest}`);
	return `${drive}:${normalizedRest || "/"}`;
}

function normalizeWindowsUncAbsolute(pathValue: string): string | null {
	if (!isWindowsUncPath(pathValue)) return null;
	const slashNormalized = pathValue.replace(/\\/g, "/");
	const withoutPrefix = slashNormalized.replace(/^\/\/+/, "");
	const [host, share, ...rest] = withoutPrefix.split("/").filter(Boolean);
	if (!host || !share) return null;
	const tail = normalizePathSegments(`/${rest.join("/")}`).replace(/^\//, "");
	return tail.length > 0
		? `//${host.toLowerCase()}/${share.toLowerCase()}/${tail}`
		: `//${host.toLowerCase()}/${share.toLowerCase()}`;
}

function normalizeRelativePath(pathValue: string): string {
	return normalizePathSegments(pathValue.replace(/\\/g, "/"));
}

function toAbsolutePath(pathValue: string, workspaceRoot: string): string {
	const trimmed = pathValue.trim();
	if (!trimmed) return normalizeUnixAbsolute(resolve(workspaceRoot));

	const windowsDriveAbsolute = normalizeWindowsDriveAbsolute(trimmed);
	if (windowsDriveAbsolute) return windowsDriveAbsolute;

	const windowsUncAbsolute = normalizeWindowsUncAbsolute(trimmed);
	if (windowsUncAbsolute) return windowsUncAbsolute;

	if (trimmed.startsWith("/")) return normalizeUnixAbsolute(trimmed);

	const normalizedRelative = normalizeRelativePath(trimmed);
	if (!normalizedRelative) {
		return toAbsolutePath(workspaceRoot, workspaceRoot);
	}

	const workspaceWindowsDrive = normalizeWindowsDriveAbsolute(workspaceRoot);
	if (workspaceWindowsDrive) {
		return normalizeWindowsDriveAbsolute(
			`${workspaceWindowsDrive}/${normalizedRelative}`,
		) as string;
	}

	const workspaceWindowsUnc = normalizeWindowsUncAbsolute(workspaceRoot);
	if (workspaceWindowsUnc) {
		return normalizeWindowsUncAbsolute(
			`${workspaceWindowsUnc}/${normalizedRelative}`,
		) as string;
	}

	return normalizeUnixAbsolute(resolve(workspaceRoot, normalizedRelative));
}

function normalizeAllowlistedRoots(input: {
	workspaceRoot: string;
	allowlistedRoots?: string[];
}): string[] {
	const roots = (input.allowlistedRoots ?? [])
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.map((value) => toAbsolutePath(value, input.workspaceRoot));

	if (roots.length > 0) {
		return [...new Set(roots)];
	}

	return [toAbsolutePath(input.workspaceRoot, input.workspaceRoot)];
}

function isPathWithinRoot(absolutePath: string, root: string): boolean {
	const normalizedPath = toAbsolutePath(absolutePath, root);
	const normalizedRoot = toAbsolutePath(root, root);

	const pathIsWindows =
		isWindowsDriveAbsolutePath(normalizedPath) ||
		isWindowsUncPath(normalizedPath);
	const rootIsWindows =
		isWindowsDriveAbsolutePath(normalizedRoot) ||
		isWindowsUncPath(normalizedRoot);
	if (pathIsWindows !== rootIsWindows) return false;

	if (pathIsWindows && rootIsWindows) {
		const pathLower = normalizedPath.toLowerCase();
		const rootLower = normalizedRoot.toLowerCase();
		if (pathLower === rootLower) return true;
		return pathLower.startsWith(`${rootLower}/`);
	}

	const relPath = relative(normalizedRoot, normalizedPath).replace(/\\/g, "/");
	if (relPath === ".") return true;
	return !(relPath === ".." || relPath.startsWith("../"));
}

function getTrustedCandidatePath(input: {
	filePath: string | undefined;
	workspaceRoot: string;
	allowlistedRoots: string[];
}): string | null {
	if (!input.filePath) return null;

	const trimmed = input.filePath.trim();
	if (!trimmed) return null;

	if (trimmed.includes("\0")) return null;

	const absolute = toAbsolutePath(trimmed, input.workspaceRoot);
	const trusted = input.allowlistedRoots.some((root) =>
		isPathWithinRoot(absolute, root),
	);
	if (!trusted) return null;
	return absolute;
}

function estimateTokenCount(value: string): number {
	return Math.max(1, Math.ceil(value.length / 4));
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return value.slice(0, maxLength);
	if (maxLength <= 3) return value.slice(0, maxLength);
	return `${value.slice(0, maxLength - 3)}...`;
}

function isSensitivePath(pathValue: string | undefined): boolean {
	if (!pathValue) return false;
	return SENSITIVE_PATH_PATTERN.test(pathValue);
}

function isSensitivePattern(pattern: string): boolean {
	return PRIVATE_KEY_PATTERN.test(pattern) || SECRET_PATTERN.test(pattern);
}

function formatPatternLine(record: RankedPatternRecord): string {
	const severity = record.severity.toUpperCase();
	const confidence = `${Math.round(record.confidence * 100)}%`;
	const score = `${Math.round(record.score * 100)}%`;
	const patternText = truncate(
		compactWhitespace(redactText(record.pattern)),
		120,
	);
	const location = record.file_path
		? ` @ ${truncate(compactWhitespace(redactText(record.file_path)), 88)}`
		: "";
	const symbol = record.symbol
		? ` #${truncate(compactWhitespace(redactText(record.symbol)), 44)}`
		: "";
	const tags =
		record.tags.length > 0 ? ` tags:${record.tags.slice(0, 2).join(",")}` : "";

	return `- [${severity}] conf=${confidence} score=${score} ${patternText}${location}${symbol}${tags}`;
}

function buildInjectionBlock(
	rankedPatterns: RankedPatternRecord[],
	options: InjectionFormatterOptions,
): string | null {
	const header =
		"<system-reminder>\n[context-scout]\nMined workspace patterns (privacy-filtered, budgeted):";
	const footer = "</system-reminder>";

	let tokenCount = estimateTokenCount(header) + estimateTokenCount(footer);
	const lines: string[] = [];

	for (const record of rankedPatterns) {
		if (record.confidence < options.minConfidence) continue;
		if (isSensitivePath(record.file_path)) continue;
		if (isSensitivePattern(record.pattern)) continue;

		const line = formatPatternLine(record);
		if (!line.trim()) continue;

		const nextCount = tokenCount + estimateTokenCount(line);
		if (nextCount > options.maxTokens) break;

		tokenCount = nextCount;
		lines.push(line);
		if (lines.length >= options.maxPatterns) break;
	}

	if (lines.length === 0) return null;

	return `${header}\n${lines.join("\n")}\n${footer}`;
}

export function createContextScoutHook(
	options: ContextScoutHookOptions,
): (
	input: ToolExecuteAfterInput,
	output: ToolExecuteAfterOutput,
) => Promise<void> {
	const enabled = options.enabled ?? false;
	const now = options.now ?? (() => Date.now());
	const workspaceRoot = resolve(options.workspaceRoot ?? Bun.env.PWD ?? ".");
	const allowlistedRoots = normalizeAllowlistedRoots({
		workspaceRoot,
		allowlistedRoots: options.allowlistedRoots,
	});
	const extractionTools = new Set(
		(options.allowedExtractionTools ?? [...EXTRACTION_TOOLS]).map(
			normalizeToolName,
		),
	);
	const injectionTools = new Set(
		(options.allowedInjectionTools ?? [...INJECTION_TOOLS]).map(
			normalizeToolName,
		),
	);
	const maxPatterns = Math.max(
		1,
		Math.floor(options.maxInjectionPatterns ?? DEFAULT_MAX_INJECTION_PATTERNS),
	);
	const maxTokens = Math.max(
		80,
		Math.floor(options.maxInjectionTokens ?? DEFAULT_INJECTION_TOKEN_BUDGET),
	);
	const maxExtractionOutputChars = Math.max(
		500,
		Math.floor(
			options.maxExtractionOutputChars ?? DEFAULT_MAX_EXTRACTION_OUTPUT_CHARS,
		),
	);
	const freshnessWindowMs = Math.max(
		60_000,
		Math.floor(options.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS),
	);
	const minConfidence = Math.min(
		1,
		Math.max(0, options.minConfidence ?? DEFAULT_MIN_CONFIDENCE),
	);
	const minSeverity = options.minSeverity ?? DEFAULT_MIN_SEVERITY;

	return async (input, output) => {
		if (!enabled) return;
		if (
			typeof output.output !== "string" ||
			output.output.trim().length === 0
		) {
			return;
		}

		const toolName = normalizeToolName(input.tool);
		const shouldExtract = extractionTools.has(toolName);
		const shouldInject = injectionTools.has(toolName);

		if (!shouldExtract && !shouldInject) return;

		const nowMs = now();

		try {
			if (shouldExtract) {
				const boundedOutput =
					output.output.length > maxExtractionOutputChars
						? output.output.slice(0, maxExtractionOutputChars)
						: output.output;
				const candidates = extractPatternCandidates([
					{ tool: toolName, output: boundedOutput },
				])
					.map((candidate) => {
						const trustedPath = getTrustedCandidatePath({
							filePath: candidate.file_path,
							workspaceRoot,
							allowlistedRoots,
						});

						const requiresTrustedPath = PATH_TRUST_REQUIRED_SOURCES.has(
							candidate.source_tool,
						);
						if (requiresTrustedPath && !trustedPath) {
							return null;
						}

						if (isSensitivePath(trustedPath ?? candidate.file_path))
							return null;
						if (isSensitivePattern(candidate.pattern)) return null;

						return {
							...candidate,
							file_path: trustedPath ?? undefined,
							pattern: compactWhitespace(redactText(candidate.pattern)),
						};
					})
					.filter((candidate) => candidate !== null)
					.filter((candidate) => candidate.pattern.length > 0);

				if (candidates.length > 0) {
					await options.stateManager.upsertPatterns(candidates, nowMs);
				}
			}

			await options.stateManager.pruneExpired(nowMs);

			if (shouldInject) {
				if (output.output.includes("[context-scout]")) return;

				const rankedPatterns = (
					await options.stateManager.listRankedPatterns({
						nowMs,
						severity_at_least: minSeverity,
						limit: Math.max(maxPatterns * 4, maxPatterns),
					})
				).filter((record) => {
					const lastSeen = new Date(record.last_seen_at).getTime();
					if (!Number.isFinite(lastSeen)) return false;
					return nowMs - lastSeen <= freshnessWindowMs;
				});

				const injection = buildInjectionBlock(rankedPatterns, {
					maxPatterns,
					maxTokens,
					minConfidence,
				});

				if (injection) {
					output.output = `${output.output}\n\n${injection}`;
				}
			}
		} catch (error) {
			logger.warn("ContextScout hook degraded gracefully", {
				tool: toolName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
