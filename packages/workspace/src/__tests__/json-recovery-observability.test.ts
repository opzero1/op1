import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	getJsonRecoveryObservabilitySnapshot,
	recordJsonRecoveryFailure,
	recordJsonRecoveryMatch,
	resetJsonRecoveryObservabilityState,
} from "../json-recovery-observability";

afterEach(() => {
	resetJsonRecoveryObservabilityState();
});

beforeEach(() => {
	resetJsonRecoveryObservabilityState();
});

describe("json recovery observability", () => {
	test("records recovery matches by method", () => {
		recordJsonRecoveryMatch(
			"/tmp/plan-registry.json",
			"trailing_comma_cleanup",
			1000,
		);
		recordJsonRecoveryMatch(
			"/tmp/active-plan.json",
			"object_boundary_extraction",
			2000,
		);

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.match_total).toBe(2);
		expect(snapshot.per_method.trailing_comma_cleanup).toBe(1);
		expect(snapshot.per_method.object_boundary_extraction).toBe(1);
		expect(snapshot.per_method.array_boundary_extraction).toBe(0);
	});

	test("deduplicates repeated recovery markers per source and method", () => {
		const first = recordJsonRecoveryMatch(
			"/tmp/plan-registry.json",
			"trailing_comma_cleanup",
			1000,
		);
		const second = recordJsonRecoveryMatch(
			"/tmp/plan-registry.json",
			"trailing_comma_cleanup",
			2000,
		);

		expect(first.suppressed).toBe(false);
		expect(second.suppressed).toBe(true);

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.match_total).toBe(1);
		expect(snapshot.dedup_skip_total).toBe(1);
	});

	test("records parse recovery failures", () => {
		recordJsonRecoveryFailure();
		recordJsonRecoveryFailure();

		const snapshot = getJsonRecoveryObservabilitySnapshot();
		expect(snapshot.parse_fail_total).toBe(2);
	});
});
