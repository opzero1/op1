import { homedir, join } from "../bun-compat.js";
import {
	getReadableMcpPointerVersions,
	isReadableMcpPointerVersion,
	type McpPointerIndex,
	type McpPointerIndexKnown,
	migratePointerIndexToCurrent,
	resolveCompatibilitySource,
} from "./mcp-pointer-contract.js";
import { enforceMcpPointerAvailability } from "./mcp-pointer-enforcement.js";

export interface McpPointerRuntimeIssue {
	code: string;
	message: string;
	path?: string;
}

export interface McpPointerRuntimeResolution {
	source: "pointer" | "legacy";
	index?: McpPointerIndex;
	migratedFromVersion?: number;
	blocking: boolean;
	blockingRequired: string[];
	issues: McpPointerRuntimeIssue[];
}

function isPointerRequirement(
	value: unknown,
): value is "required" | "optional" {
	return value === "required" || value === "optional";
}

function isPointerLifecycleState(
	value: unknown,
): value is "idle" | "starting" | "ready" | "degraded" | "closed" {
	return (
		value === "idle" ||
		value === "starting" ||
		value === "ready" ||
		value === "degraded" ||
		value === "closed"
	);
}

function isPointerHealthStatus(
	value: unknown,
): value is "healthy" | "degraded" | "unavailable" {
	return value === "healthy" || value === "degraded" || value === "unavailable";
}

function isPointerServerEntry(
	value: unknown,
): value is McpPointerIndex["servers"][number] {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	const capability = candidate.capability as
		| Record<string, unknown>
		| undefined;
	const auth = candidate.auth as Record<string, unknown> | undefined;
	const hasValidCapability =
		typeof capability === "object" &&
		capability !== null &&
		typeof capability.tool_pattern === "string";
	const hasValidAuth =
		typeof auth === "object" &&
		auth !== null &&
		typeof auth.oauth_capable === "boolean" &&
		(auth.auth_status === "authenticated" ||
			auth.auth_status === "expired" ||
			auth.auth_status === "not_authenticated" ||
			auth.auth_status === "unknown");

	return (
		typeof candidate.id === "string" &&
		isPointerRequirement(candidate.requirement) &&
		isPointerLifecycleState(candidate.lifecycle_state) &&
		isPointerHealthStatus(candidate.health_status) &&
		hasValidCapability &&
		hasValidAuth
	);
}

function createPointerUnavailableResolution(input: {
	mode: "legacy-only" | "pointer-only" | "mixed";
	issue: McpPointerRuntimeIssue;
}): McpPointerRuntimeResolution {
	const sourceResolution = resolveCompatibilitySource({
		mode: input.mode,
		pointerAvailable: false,
		legacyAvailable: true,
		requirement: "required",
	});

	const source =
		input.mode === "pointer-only" && !sourceResolution.ok
			? "pointer"
			: "legacy";

	return {
		source,
		blocking: !sourceResolution.ok,
		blockingRequired: sourceResolution.ok ? [] : ["__pointer_index__"],
		issues: [input.issue],
	};
}

function hashText(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

export async function resolveMcpPointerIndex(input?: {
	homeDirectory?: string;
	mode?: "legacy-only" | "pointer-only" | "mixed";
}): Promise<McpPointerRuntimeResolution> {
	const homeDirectory = input?.homeDirectory ?? homedir();
	const mode = input?.mode ?? "mixed";
	const pointerDir = join(homeDirectory, ".config", "opencode", ".mcp-pointer");
	const indexPath = join(pointerDir, "index.json");
	const checksumPath = join(pointerDir, "index.sha256");
	const issues: McpPointerRuntimeIssue[] = [];

	const indexFile = Bun.file(indexPath);
	if (!(await indexFile.exists())) {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "missing_pointer_index",
				message: "MCP pointer index not found.",
				path: indexPath,
			},
		});
	}

	const checksumFile = Bun.file(checksumPath);
	if (!(await checksumFile.exists())) {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "missing_pointer_checksum",
				message: "MCP pointer checksum missing.",
				path: checksumPath,
			},
		});
	}

	let indexText: string;
	try {
		indexText = await indexFile.text();
	} catch {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "pointer_index_read_failed",
				message: "MCP pointer index could not be read.",
				path: indexPath,
			},
		});
	}

	let expectedChecksum: string;
	try {
		expectedChecksum = (await checksumFile.text()).trim();
	} catch {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "pointer_checksum_read_failed",
				message: "MCP pointer checksum could not be read.",
				path: checksumPath,
			},
		});
	}

	const actualChecksum = hashText(indexText);
	if (expectedChecksum !== actualChecksum) {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "pointer_checksum_mismatch",
				message: "MCP pointer checksum mismatch.",
				path: indexPath,
			},
		});
	}

	let parsed: McpPointerIndexKnown;
	try {
		parsed = JSON.parse(indexText) as McpPointerIndexKnown;
	} catch {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "malformed_pointer_index",
				message: "MCP pointer index is invalid JSON.",
				path: indexPath,
			},
		});
	}

	if (
		!isReadableMcpPointerVersion({
			version: parsed.version,
			readableVersions: getReadableMcpPointerVersions(),
		})
	) {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "unsupported_pointer_version",
				message: `Unsupported MCP pointer version ${String(parsed.version)}.`,
				path: indexPath,
			},
		});
	}

	const migrated = migratePointerIndexToCurrent({ index: parsed });
	const selectedSource = resolveCompatibilitySource({
		mode,
		pointerAvailable: true,
		legacyAvailable: true,
		requirement: "optional",
	});
	const source = selectedSource.ok ? selectedSource.source : "legacy";
	if (
		!Array.isArray(migrated.index.servers) ||
		!migrated.index.servers.every((server) => isPointerServerEntry(server))
	) {
		return createPointerUnavailableResolution({
			mode,
			issue: {
				code: "malformed_pointer_schema",
				message: "MCP pointer index schema is invalid.",
				path: indexPath,
			},
		});
	}

	const availabilityStatuses = migrated.index.servers.map((server) => ({
		serverId: server.id,
		requirement: server.requirement,
		available:
			source === "pointer"
				? server.health_status === "healthy" &&
					(server.lifecycle_state === "ready" ||
						server.lifecycle_state === "idle")
				: true,
	}));

	let resolvedSource: "pointer" | "legacy" = source;
	let enforcement = enforceMcpPointerAvailability(availabilityStatuses);

	if (
		mode === "mixed" &&
		resolvedSource === "pointer" &&
		enforcement.blockingRequired.length > 0
	) {
		resolvedSource = "legacy";
		enforcement = enforceMcpPointerAvailability(
			availabilityStatuses.map((status) => ({
				...status,
				available: true,
			})),
		);
		issues.push({
			code: "pointer_required_unavailable_fallback",
			message:
				"Required MCP pointer servers are not ready; falling back to legacy MCP mode.",
			path: indexPath,
		});
	}

	if (migrated.migrated) {
		issues.push({
			code: "pointer_index_migrated",
			message: `MCP pointer index migrated from version ${String(migrated.from_version)} to current runtime contract.`,
			path: indexPath,
		});
	}

	return {
		source: resolvedSource,
		index: migrated.index,
		migratedFromVersion: migrated.migrated ? migrated.from_version : undefined,
		blocking: !enforcement.ok,
		blockingRequired: enforcement.blockingRequired,
		issues,
	};
}
