export const MCP_POINTER_INDEX_VERSION = 1;

export type McpPointerRequirement = "required" | "optional";
export type McpPointerMode = "legacy-only" | "pointer-only" | "mixed";

export type McpPointerLifecycleState =
	| "idle"
	| "starting"
	| "ready"
	| "degraded"
	| "closed";

export type McpPointerLifecycleEvent =
	| "start_requested"
	| "start_succeeded"
	| "start_failed"
	| "retry_scheduled"
	| "retry_exhausted"
	| "degrade_detected"
	| "recover_detected"
	| "close_requested"
	| "close_completed";

export interface McpPointerCapabilityMetadata {
	tool_pattern: string;
	list_changed_supported: boolean;
	soft_ttl_ms: number;
	hard_ttl_ms: number;
	last_refreshed_at?: string;
	stale_at?: string;
	expires_at?: string;
}

export interface McpPointerAuthMetadata {
	oauth_capable: boolean;
	auth_status: "authenticated" | "expired" | "not_authenticated" | "unknown";
	has_client_id: boolean;
	has_client_secret: boolean;
	last_error_code?: string;
}

export interface McpPointerServerEntry {
	id: string;
	name: string;
	source_config: string;
	transport: "local" | "remote";
	requirement: McpPointerRequirement;
	fingerprint_sha256: string;
	lifecycle_state: McpPointerLifecycleState;
	health_status: "healthy" | "degraded" | "unavailable";
	capability: McpPointerCapabilityMetadata;
	auth: McpPointerAuthMetadata;
}

export interface McpPointerIndex {
	version: number;
	generated_at: string;
	generated_by: string;
	compatibility: {
		read: number[];
		write: number;
	};
	failure_policy: {
		required: "fail_closed";
		optional: "degraded";
	};
	lifecycle_policy: McpPointerLifecyclePolicy;
	staleness_policy: McpPointerStalenessPolicy;
	compatibility_matrix: McpPointerCompatibilityMatrix;
	security_policy: McpPointerSecurityPolicy;
	servers: McpPointerServerEntry[];
}

export type McpPointerAuthErrorCode =
	| "auth_missing"
	| "auth_expired"
	| "auth_malformed"
	| "auth_transport_failure";

export interface McpPointerSecurityPolicy {
	token_storage: "auth_store_only";
	requires_oauth_state: true;
	redact_fields: string[];
	typed_error_codes: McpPointerAuthErrorCode[];
}

export interface McpPointerIndexV0 {
	version: 0;
	generated_at: string;
	servers: McpPointerServerEntry[];
}

export type McpPointerIndexKnown = McpPointerIndex | McpPointerIndexV0;

export interface McpPointerCompatibilityMatrix {
	mode: McpPointerMode;
	precedence: {
		mixed: ["pointer", "legacy"];
		pointer_only: ["pointer"];
		legacy_only: ["legacy"];
	};
	error_policy: {
		required_missing: "fail_closed";
		optional_missing: "degraded";
	};
}

export interface McpPointerStalenessPolicy {
	soft_ttl_ms: number;
	hard_ttl_ms: number;
	refresh_jitter_ratio: number;
	invalidate_on_error_codes: string[];
}

export interface McpPointerRetryPolicy {
	max_attempts: number;
	base_backoff_ms: number;
	max_backoff_ms: number;
	jitter_ratio: number;
}

export interface McpPointerLifecyclePolicy {
	concurrency: {
		start_request_dedupe: "singleflight";
		close_during_start: "mark_closing_then_close_after_start_settles";
		cancel_start_on_close: true;
	};
	retry: McpPointerRetryPolicy;
	transition_table: Record<
		McpPointerLifecycleState,
		Partial<Record<McpPointerLifecycleEvent, McpPointerLifecycleState>>
	>;
}

export const MCP_POINTER_LIFECYCLE_POLICY: McpPointerLifecyclePolicy = {
	concurrency: {
		start_request_dedupe: "singleflight",
		close_during_start: "mark_closing_then_close_after_start_settles",
		cancel_start_on_close: true,
	},
	retry: {
		max_attempts: 3,
		base_backoff_ms: 500,
		max_backoff_ms: 4000,
		jitter_ratio: 0.2,
	},
	transition_table: {
		idle: {
			start_requested: "starting",
			close_requested: "closed",
			close_completed: "closed",
		},
		starting: {
			start_succeeded: "ready",
			start_failed: "degraded",
			retry_scheduled: "starting",
			retry_exhausted: "degraded",
			close_requested: "closed",
			close_completed: "closed",
		},
		ready: {
			degrade_detected: "degraded",
			close_requested: "closed",
			close_completed: "closed",
		},
		degraded: {
			recover_detected: "ready",
			start_requested: "starting",
			retry_scheduled: "starting",
			close_requested: "closed",
			close_completed: "closed",
		},
		closed: {
			start_requested: "starting",
			close_requested: "closed",
			close_completed: "closed",
		},
	},
};

export const MCP_POINTER_STALENESS_POLICY: McpPointerStalenessPolicy = {
	soft_ttl_ms: 5 * 60 * 1000,
	hard_ttl_ms: 30 * 60 * 1000,
	refresh_jitter_ratio: 0.2,
	invalidate_on_error_codes: [
		"auth_expired",
		"transport_unreachable",
		"capability_mismatch",
	],
};

export const MCP_POINTER_COMPATIBILITY_DEFAULT: McpPointerCompatibilityMatrix =
	{
		mode: "mixed",
		precedence: {
			mixed: ["pointer", "legacy"],
			pointer_only: ["pointer"],
			legacy_only: ["legacy"],
		},
		error_policy: {
			required_missing: "fail_closed",
			optional_missing: "degraded",
		},
	};

export const MCP_POINTER_SECURITY_POLICY: McpPointerSecurityPolicy = {
	token_storage: "auth_store_only",
	requires_oauth_state: true,
	redact_fields: [
		"accessToken",
		"refreshToken",
		"clientSecret",
		"Authorization",
	],
	typed_error_codes: [
		"auth_missing",
		"auth_expired",
		"auth_malformed",
		"auth_transport_failure",
	],
};

export function resolveLifecycleTransition(input: {
	state: McpPointerLifecycleState;
	event: McpPointerLifecycleEvent;
}): McpPointerLifecycleState | null {
	const next =
		MCP_POINTER_LIFECYCLE_POLICY.transition_table[input.state][input.event];

	return next ?? null;
}

export function shouldInvalidateOnError(input: { errorCode: string }): boolean {
	return MCP_POINTER_STALENESS_POLICY.invalidate_on_error_codes.includes(
		input.errorCode,
	);
}

export function computeRefreshWindow(input: {
	nowMs: number;
	softTtlMs?: number;
	hardTtlMs?: number;
	jitterRatio?: number;
}): {
	refresh_at_ms: number;
	expires_at_ms: number;
} {
	const softTtlMs = input.softTtlMs ?? MCP_POINTER_STALENESS_POLICY.soft_ttl_ms;
	const hardTtlMs = input.hardTtlMs ?? MCP_POINTER_STALENESS_POLICY.hard_ttl_ms;
	const jitterRatio =
		input.jitterRatio ?? MCP_POINTER_STALENESS_POLICY.refresh_jitter_ratio;
	const boundedJitterRatio = Math.min(Math.max(jitterRatio, 0), 1);
	const jitterMs = Math.floor(softTtlMs * boundedJitterRatio);

	return {
		refresh_at_ms: input.nowMs + softTtlMs + jitterMs,
		expires_at_ms: input.nowMs + hardTtlMs,
	};
}

export function resolveCompatibilitySource(input: {
	mode: McpPointerMode;
	pointerAvailable: boolean;
	legacyAvailable: boolean;
	requirement: McpPointerRequirement;
}):
	| { ok: true; source: "pointer" | "legacy" }
	| {
			ok: false;
			code:
				| "required_unavailable"
				| "optional_unavailable"
				| "mode_unavailable";
	  } {
	const requiredFailure = input.requirement === "required";

	if (input.mode === "pointer-only") {
		if (input.pointerAvailable) {
			return { ok: true, source: "pointer" };
		}
		return {
			ok: false,
			code: requiredFailure ? "required_unavailable" : "optional_unavailable",
		};
	}

	if (input.mode === "legacy-only") {
		if (input.legacyAvailable) {
			return { ok: true, source: "legacy" };
		}
		return {
			ok: false,
			code: requiredFailure ? "required_unavailable" : "optional_unavailable",
		};
	}

	if (input.pointerAvailable) {
		return { ok: true, source: "pointer" };
	}

	if (input.legacyAvailable) {
		return { ok: true, source: "legacy" };
	}

	return {
		ok: false,
		code: requiredFailure ? "required_unavailable" : "mode_unavailable",
	};
}

export function getReadableMcpPointerVersions(
	version = MCP_POINTER_INDEX_VERSION,
): number[] {
	if (version <= 1) {
		return [version];
	}

	return [version, version - 1];
}

export function migratePointerIndexToCurrent(input: {
	index: McpPointerIndexKnown;
}): {
	migrated: boolean;
	from_version: number;
	index: McpPointerIndex;
} {
	if (input.index.version === MCP_POINTER_INDEX_VERSION) {
		return {
			migrated: false,
			from_version: input.index.version,
			index: input.index,
		};
	}

	return {
		migrated: true,
		from_version: input.index.version,
		index: {
			version: 1,
			generated_at: input.index.generated_at,
			generated_by: "@op1/install",
			compatibility: {
				read: getReadableMcpPointerVersions(MCP_POINTER_INDEX_VERSION),
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
			servers: input.index.servers,
		},
	};
}

export function redactSensitiveAuthMetadata(
	input: Record<string, unknown>,
): Record<string, unknown> {
	const redacted: Record<string, unknown> = {};
	const redactSet = new Set(MCP_POINTER_SECURITY_POLICY.redact_fields);

	for (const [key, value] of Object.entries(input)) {
		redacted[key] = redactSet.has(key) ? "[REDACTED]" : value;
	}

	return redacted;
}

export function toTypedAuthErrorCode(input: {
	errorCode: string;
}): McpPointerAuthErrorCode | "auth_transport_failure" {
	const code = input.errorCode as McpPointerAuthErrorCode;
	if (MCP_POINTER_SECURITY_POLICY.typed_error_codes.includes(code)) {
		return code;
	}

	return "auth_transport_failure";
}

export function isReadableMcpPointerVersion(input: {
	version: number;
	readableVersions: number[];
}): boolean {
	return input.readableVersions.includes(input.version);
}
