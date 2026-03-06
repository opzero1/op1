import { describe, expect, test } from "bun:test";
import {
	computeContractChecksum,
	isCompatibleSchemaVersion,
	normalizeContractForChecksum,
	parseSkillPointerContract,
} from "../skill-pointer-contract";

describe("skill pointer contract", () => {
	test("accepts same-major lower-minor writer versions", () => {
		expect(
			isCompatibleSchemaVersion({
				readerVersion: "1.4.0",
				writerVersion: "1.2.0",
			}),
		).toBe(true);

		expect(
			isCompatibleSchemaVersion({
				readerVersion: "1.2.0",
				writerVersion: "1.4.0",
			}),
		).toBe(false);

		expect(
			isCompatibleSchemaVersion({
				readerVersion: "2.0.0",
				writerVersion: "1.9.0",
			}),
		).toBe(false);
	});

	test("normalizes checksum deterministically", () => {
		const { contract } = parseSkillPointerContract({
			schema_version: "1.0.0",
			release_train_id: "train-9",
			source_contract_sha: "abc",
			allowed_modes: ["exclusive", "fallback"],
			failure_classes: [
				"pointer_unavailable_fallback",
				"pointer_required_unavailable",
				"pointer_integrity_mismatch",
			],
			materialization_states: ["ready", "stubbed", "degraded", "materializing"],
			required_payload_fields: [
				"failure_classes",
				"allowed_modes",
				"schema_version",
			],
		});

		const a = normalizeContractForChecksum(contract);
		const b = normalizeContractForChecksum(
			parseSkillPointerContract(JSON.parse(JSON.stringify(contract))).contract,
		);

		expect(a).toBe(b);
		expect(computeContractChecksum(contract)).toBe(
			computeContractChecksum(parseSkillPointerContract(contract).contract),
		);
	});

	test("degrades unknown fields and enums safely", () => {
		const parsed = parseSkillPointerContract({
			schema_version: "1.0.0",
			release_train_id: "train-10",
			source_contract_sha: "xyz",
			allowed_modes: ["exclusive", "future_mode"],
			failure_classes: ["pointer_required_unavailable", "future_failure"],
			materialization_states: ["ready", "future_state"],
			required_payload_fields: ["schema_version"],
			unexpected_field: "kept-for-forward-compat",
		});

		expect(parsed.contract.allowed_modes).toEqual(["exclusive"]);
		expect(parsed.contract.failure_classes).toEqual([
			"pointer_required_unavailable",
		]);
		expect(parsed.contract.materialization_states).toEqual(["ready"]);
		expect(parsed.unknownFields).toEqual(["unexpected_field"]);
		expect(parsed.degradedEnums).toContain("allowed_modes:future_mode");
		expect(parsed.degradedEnums).toContain("failure_classes:future_failure");
		expect(parsed.degradedEnums).toContain(
			"materialization_states:future_state",
		);
	});
});
