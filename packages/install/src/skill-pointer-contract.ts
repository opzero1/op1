export const SKILL_POINTER_CONTRACT_SCHEMA_VERSION = "1.0.0";

export type SkillPointerMode = "fallback" | "exclusive";

export type SkillPointerFailureClass =
	| "pointer_required_unavailable"
	| "pointer_integrity_mismatch"
	| "pointer_unavailable_fallback";

export type SkillPointerMaterializationState =
	| "stubbed"
	| "materializing"
	| "ready"
	| "degraded";

export interface SkillPointerContract {
	schema_version: string;
	release_train_id: string;
	source_contract_sha: string;
	allowed_modes: SkillPointerMode[];
	failure_classes: SkillPointerFailureClass[];
	materialization_states: SkillPointerMaterializationState[];
	required_payload_fields: string[];
}

const DEFAULT_CONTRACT: SkillPointerContract = {
	schema_version: SKILL_POINTER_CONTRACT_SCHEMA_VERSION,
	release_train_id: "local-dev",
	source_contract_sha: "",
	allowed_modes: ["fallback", "exclusive"],
	failure_classes: [
		"pointer_required_unavailable",
		"pointer_integrity_mismatch",
		"pointer_unavailable_fallback",
	],
	materialization_states: ["stubbed", "materializing", "ready", "degraded"],
	required_payload_fields: [
		"schema_version",
		"release_train_id",
		"source_contract_sha",
		"allowed_modes",
		"failure_classes",
		"materialization_states",
	],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toStringArray(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input.filter((entry): entry is string => typeof entry === "string");
}

function parseSemver(
	value: string,
): { major: number; minor: number; patch: number } | null {
	const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return null;
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
	};
}

export function isCompatibleSchemaVersion(input: {
	readerVersion: string;
	writerVersion: string;
}): boolean {
	const reader = parseSemver(input.readerVersion);
	const writer = parseSemver(input.writerVersion);
	if (!reader || !writer) return false;
	if (reader.major !== writer.major) return false;
	if (writer.minor > reader.minor) return false;
	return true;
}

function normalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		const normalized = value.map((entry) => normalizeValue(entry));
		const withStableKeys = normalized.every((entry) =>
			isRecord(entry)
				? typeof entry.name === "string" || typeof entry.id === "string"
				: typeof entry === "string" || typeof entry === "number",
		);
		if (!withStableKeys) return normalized;

		return [...normalized].sort((left, right) => {
			const leftKey = isRecord(left)
				? String(left.name ?? left.id ?? JSON.stringify(left))
				: String(left);
			const rightKey = isRecord(right)
				? String(right.name ?? right.id ?? JSON.stringify(right))
				: String(right);
			return leftKey.localeCompare(rightKey);
		});
	}

	if (!isRecord(value)) return value;

	const sortedEntries = Object.entries(value)
		.map(([key, entry]) => [key, normalizeValue(entry)] as const)
		.sort((a, b) => a[0].localeCompare(b[0]));
	return Object.fromEntries(sortedEntries);
}

export function normalizeContractForChecksum(
	contract: SkillPointerContract,
): string {
	return `${JSON.stringify(normalizeValue(contract), null, 2)}\n`;
}

export function computeContractChecksum(
	contract: SkillPointerContract,
): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(normalizeContractForChecksum(contract));
	return hasher.digest("hex");
}

export function parseSkillPointerContract(input: unknown): {
	contract: SkillPointerContract;
	degradedEnums: string[];
	unknownFields: string[];
} {
	if (!isRecord(input)) {
		return {
			contract: DEFAULT_CONTRACT,
			degradedEnums: [],
			unknownFields: [],
		};
	}

	const knownFields = new Set([
		"schema_version",
		"release_train_id",
		"source_contract_sha",
		"allowed_modes",
		"failure_classes",
		"materialization_states",
		"required_payload_fields",
	]);

	const unknownFields = Object.keys(input).filter(
		(key) => !knownFields.has(key),
	);
	const degradedEnums: string[] = [];

	const allowedModes = toStringArray(input.allowed_modes).filter((entry) => {
		if (entry === "fallback" || entry === "exclusive") return true;
		degradedEnums.push(`allowed_modes:${entry}`);
		return false;
	}) as SkillPointerMode[];

	const failureClasses = toStringArray(input.failure_classes).filter(
		(entry) => {
			if (
				entry === "pointer_required_unavailable" ||
				entry === "pointer_integrity_mismatch" ||
				entry === "pointer_unavailable_fallback"
			)
				return true;
			degradedEnums.push(`failure_classes:${entry}`);
			return false;
		},
	) as SkillPointerFailureClass[];

	const materializationStates = toStringArray(
		input.materialization_states,
	).filter((entry) => {
		if (
			entry === "stubbed" ||
			entry === "materializing" ||
			entry === "ready" ||
			entry === "degraded"
		)
			return true;
		degradedEnums.push(`materialization_states:${entry}`);
		return false;
	}) as SkillPointerMaterializationState[];

	const contract: SkillPointerContract = {
		schema_version:
			typeof input.schema_version === "string"
				? input.schema_version
				: DEFAULT_CONTRACT.schema_version,
		release_train_id:
			typeof input.release_train_id === "string"
				? input.release_train_id
				: DEFAULT_CONTRACT.release_train_id,
		source_contract_sha:
			typeof input.source_contract_sha === "string"
				? input.source_contract_sha
				: DEFAULT_CONTRACT.source_contract_sha,
		allowed_modes:
			allowedModes.length > 0 ? allowedModes : DEFAULT_CONTRACT.allowed_modes,
		failure_classes:
			failureClasses.length > 0
				? failureClasses
				: DEFAULT_CONTRACT.failure_classes,
		materialization_states:
			materializationStates.length > 0
				? materializationStates
				: DEFAULT_CONTRACT.materialization_states,
		required_payload_fields:
			toStringArray(input.required_payload_fields).length > 0
				? toStringArray(input.required_payload_fields)
				: DEFAULT_CONTRACT.required_payload_fields,
	};

	return {
		contract,
		degradedEnums,
		unknownFields,
	};
}
