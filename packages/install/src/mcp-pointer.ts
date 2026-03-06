import { rename } from "node:fs/promises";

import {
	getMcpPointerReadableVersions,
	isReadableMcpPointerVersion,
	MCP_POINTER_COMPATIBILITY_DEFAULT,
	MCP_POINTER_INDEX_VERSION,
	MCP_POINTER_LIFECYCLE_POLICY,
	MCP_POINTER_SECURITY_POLICY,
	MCP_POINTER_STALENESS_POLICY,
	type McpPointerIndex,
	type McpPointerRequirement,
	type McpPointerServerEntry,
} from "./mcp-pointer-contract.js";

interface BuilderMcpConfig {
	type: "local" | "remote";
	command?: string[];
	url?: string;
	headers?: Record<string, string>;
	environment?: Record<string, string>;
}

export interface BuilderMcpDefinition {
	id: string;
	name: string;
	toolPattern: string;
	required: McpPointerRequirement;
	oauthCapable?: boolean;
	config: BuilderMcpConfig;
	sourceConfigPath: string;
}

export interface BuildMcpPointerIndexOptions {
	nowMs?: number;
	mcps: BuilderMcpDefinition[];
}

export interface McpPointerIntegrityIssue {
	code: string;
	message: string;
	path?: string;
}

export interface McpPointerIntegrityResult {
	ok: boolean;
	issues: McpPointerIntegrityIssue[];
}

export interface InstallMcpPointerArtifactsOptions {
	configDir: string;
	nowMs?: number;
	dryRun?: boolean;
	totalCatalogMcpCount: number;
	mcps: BuilderMcpDefinition[];
}

export interface InstallMcpPointerArtifactsResult {
	applied: boolean;
	fallbackToLegacy: boolean;
	fileWrites: number;
	indexPath: string;
	checksumPath: string;
	index: McpPointerIndex;
	activeMcpCount: number;
	deferredMcpCount: number;
}

const MCP_POINTER_DIR = ".mcp-pointer";
const MCP_POINTER_INDEX_FILE = "index.json";
const MCP_POINTER_CHECKSUM_FILE = "index.sha256";

const IS_WINDOWS = (Bun.env.OS ?? "").toLowerCase().includes("windows");

function toPosixPath(input: string): string {
	return input.replace(/\\+/g, "/");
}

function isAbsolutePath(input: string): boolean {
	if (input.startsWith("/")) {
		return true;
	}

	return /^[A-Za-z]:\//.test(input);
}

function toNativePath(input: string): string {
	if (!IS_WINDOWS) {
		return input;
	}

	return input.replace(/\//g, "\\");
}

function joinPath(...parts: string[]): string {
	const normalized = parts
		.filter((part) => part.length > 0)
		.map((part) => toPosixPath(part));

	if (normalized.length === 0) {
		return "";
	}

	let result = normalized[0];
	for (let index = 1; index < normalized.length; index += 1) {
		const part = normalized[index];
		if (isAbsolutePath(part)) {
			result = part;
			continue;
		}

		const left = result.replace(/\/+$/, "");
		const right = part.replace(/^\/+/, "");
		result = `${left}/${right}`;
	}

	return toNativePath(result);
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const marker = joinPath(
		dirPath,
		`.op1-mcp-pointer-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	await Bun.write(marker, "");
	await Bun.file(marker).delete();
}

function hashText(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

async function atomicWriteText(
	filePath: string,
	content: string,
): Promise<void> {
	const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	await Bun.write(tmpPath, content);
	await rename(tmpPath, filePath);
}

function normalizeConfigForFingerprint(config: BuilderMcpConfig): string {
	return JSON.stringify({
		type: config.type,
		command: config.command ?? null,
		url: config.url ?? null,
		headers: config.headers ?? null,
		environment: config.environment ?? null,
	});
}

function hashConfigFingerprint(config: BuilderMcpConfig): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(normalizeConfigForFingerprint(config));
	return hasher.digest("hex");
}

function buildPointerServerEntry(
	mcp: BuilderMcpDefinition,
): McpPointerServerEntry {
	const oauthCapable = mcp.oauthCapable === true;

	return {
		id: mcp.id,
		name: mcp.name,
		source_config: mcp.sourceConfigPath,
		transport: mcp.config.type,
		requirement: mcp.required,
		fingerprint_sha256: hashConfigFingerprint(mcp.config),
		lifecycle_state: "idle",
		health_status: "healthy",
		capability: {
			tool_pattern: mcp.toolPattern,
			list_changed_supported: false,
			soft_ttl_ms: MCP_POINTER_STALENESS_POLICY.soft_ttl_ms,
			hard_ttl_ms: MCP_POINTER_STALENESS_POLICY.hard_ttl_ms,
		},
		auth: {
			oauth_capable: oauthCapable,
			auth_status: oauthCapable ? "not_authenticated" : "unknown",
			has_client_id: false,
			has_client_secret: false,
		},
	};
}

export function buildMcpPointerIndex(
	options: BuildMcpPointerIndexOptions,
): McpPointerIndex {
	const nowMs = options.nowMs ?? Date.now();
	const servers = options.mcps
		.map((mcp) => buildPointerServerEntry(mcp))
		.sort((a, b) => a.id.localeCompare(b.id));

	return {
		version: MCP_POINTER_INDEX_VERSION,
		generated_at: new Date(nowMs).toISOString(),
		generated_by: "@op1/install",
		compatibility: {
			read: getMcpPointerReadableVersions(MCP_POINTER_INDEX_VERSION),
			write: MCP_POINTER_INDEX_VERSION,
		},
		failure_policy: {
			required: "fail_closed",
			optional: "degraded",
		},
		lifecycle_policy: MCP_POINTER_LIFECYCLE_POLICY,
		staleness_policy: MCP_POINTER_STALENESS_POLICY,
		compatibility_matrix: MCP_POINTER_COMPATIBILITY_DEFAULT,
		security_policy: MCP_POINTER_SECURITY_POLICY,
		servers,
	};
}

export async function validateMcpPointerArtifacts(input: {
	indexPath: string;
	checksumPath: string;
}): Promise<McpPointerIntegrityResult> {
	const issues: McpPointerIntegrityIssue[] = [];
	const indexFile = Bun.file(input.indexPath);
	if (!(await indexFile.exists())) {
		issues.push({
			code: "missing_index",
			message: "MCP pointer index file is missing.",
			path: input.indexPath,
		});
		return { ok: false, issues };
	}

	const checksumFile = Bun.file(input.checksumPath);
	if (!(await checksumFile.exists())) {
		issues.push({
			code: "missing_checksum",
			message: "MCP pointer checksum file is missing.",
			path: input.checksumPath,
		});
		return { ok: false, issues };
	}

	const indexText = await indexFile.text();
	let parsedIndex: McpPointerIndex | null = null;
	try {
		parsedIndex = JSON.parse(indexText) as McpPointerIndex;
	} catch {
		issues.push({
			code: "malformed_index",
			message: "MCP pointer index is not valid JSON.",
			path: input.indexPath,
		});
		return { ok: false, issues };
	}

	if (
		!isReadableMcpPointerVersion({
			version: parsedIndex.version,
			readableVersions: getMcpPointerReadableVersions(
				MCP_POINTER_INDEX_VERSION,
			),
		})
	) {
		issues.push({
			code: "unsupported_version",
			message: `Unsupported MCP pointer index version ${String(parsedIndex.version)}.`,
			path: input.indexPath,
		});
	}

	const expectedChecksum = (await checksumFile.text()).trim();
	const actualChecksum = hashText(indexText);
	if (expectedChecksum !== actualChecksum) {
		issues.push({
			code: "checksum_mismatch",
			message: "MCP pointer index checksum mismatch.",
			path: input.indexPath,
		});
	}

	const ids = new Set<string>();
	for (const server of parsedIndex.servers ?? []) {
		if (!server.id || !server.capability?.tool_pattern) {
			issues.push({
				code: "incomplete_server",
				message: "MCP pointer server entry is incomplete.",
			});
			continue;
		}

		if (ids.has(server.id)) {
			issues.push({
				code: "duplicate_server_id",
				message: `Duplicate MCP pointer server id: ${server.id}.`,
			});
			continue;
		}

		ids.add(server.id);
	}

	return {
		ok: issues.length === 0,
		issues,
	};
}

export async function installMcpPointerArtifacts(
	options: InstallMcpPointerArtifactsOptions,
): Promise<InstallMcpPointerArtifactsResult> {
	const nowMs = options.nowMs ?? Date.now();
	const pointerDir = joinPath(options.configDir, MCP_POINTER_DIR);
	const indexPath = joinPath(pointerDir, MCP_POINTER_INDEX_FILE);
	const checksumPath = joinPath(pointerDir, MCP_POINTER_CHECKSUM_FILE);

	const index = buildMcpPointerIndex({ nowMs, mcps: options.mcps });
	const activeMcpCount = options.mcps.length;
	const deferredMcpCount = Math.max(
		0,
		options.totalCatalogMcpCount - activeMcpCount,
	);

	if (options.dryRun) {
		return {
			applied: false,
			fallbackToLegacy: false,
			fileWrites: 2,
			indexPath,
			checksumPath,
			index,
			activeMcpCount,
			deferredMcpCount,
		};
	}

	await ensureDirectory(pointerDir);
	const previousIndexText = (await Bun.file(indexPath).exists())
		? await Bun.file(indexPath).text()
		: null;
	const previousChecksumText = (await Bun.file(checksumPath).exists())
		? await Bun.file(checksumPath).text()
		: null;

	const indexText = `${JSON.stringify(index, null, 2)}\n`;
	const checksumText = `${hashText(indexText)}\n`;

	let fallbackToLegacy = false;
	try {
		await atomicWriteText(indexPath, indexText);
		await atomicWriteText(checksumPath, checksumText);

		const integrity = await validateMcpPointerArtifacts({
			indexPath,
			checksumPath,
		});
		if (!integrity.ok) {
			throw new Error(
				integrity.issues
					.map((issue) => `${issue.code}: ${issue.message}`)
					.join("; "),
			);
		}
	} catch (error) {
		fallbackToLegacy = true;
		if (previousIndexText !== null && previousChecksumText !== null) {
			await atomicWriteText(indexPath, previousIndexText);
			await atomicWriteText(checksumPath, previousChecksumText);
		} else {
			if (await Bun.file(indexPath).exists()) {
				await Bun.file(indexPath).delete();
			}
			if (await Bun.file(checksumPath).exists()) {
				await Bun.file(checksumPath).delete();
			}
		}

		throw new Error(
			`MCP pointer artifact install failed, reverted to legacy mode: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return {
		applied: true,
		fallbackToLegacy,
		fileWrites: 2,
		indexPath,
		checksumPath,
		index,
		activeMcpCount,
		deferredMcpCount,
	};
}
