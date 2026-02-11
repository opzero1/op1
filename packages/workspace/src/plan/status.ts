/**
 * Auto-Status Calculation
 *
 * Automatically derives phase and plan status from task checkboxes.
 */

import { extractMarkdownParts } from "./schema.js";
import { escapeRegex } from "../utils.js";

// ==========================================
// TYPES
// ==========================================

export type PhaseStatusValue = "PENDING" | "IN PROGRESS" | "COMPLETE" | "BLOCKED";
export type PlanStatusValue = "not-started" | "in-progress" | "complete" | "blocked";

export interface PhaseData {
	number: number;
	name: string;
	status: string;
	tasks: Array<{ checked: boolean }>;
}

// ==========================================
// CALCULATION
// ==========================================

/**
 * Calculate the status of a phase based on its task completion state.
 */
export function calculatePhaseStatus(phase: PhaseData): PhaseStatusValue {
	if (phase.tasks.length === 0) return "PENDING";
	
	const allChecked = phase.tasks.every((t) => t.checked);
	const anyChecked = phase.tasks.some((t) => t.checked);
	
	// If manually set to BLOCKED, preserve it
	if (phase.status === "BLOCKED") return "BLOCKED";
	
	if (allChecked) return "COMPLETE";
	if (anyChecked) return "IN PROGRESS";
	return "PENDING";
}

/**
 * Calculate the overall plan status based on phase statuses.
 */
export function calculatePlanStatus(phases: PhaseData[]): PlanStatusValue {
	if (phases.length === 0) return "not-started";
	
	const phaseStatuses = phases.map((p) => calculatePhaseStatus(p));
	
	// If any phase is blocked, plan is blocked
	if (phaseStatuses.some((s) => s === "BLOCKED")) return "blocked";
	
	// If all phases are complete, plan is complete
	if (phaseStatuses.every((s) => s === "COMPLETE")) return "complete";
	
	// If any phase is in progress or complete, plan is in progress
	if (phaseStatuses.some((s) => s === "IN PROGRESS" || s === "COMPLETE")) {
		return "in-progress";
	}
	
	return "not-started";
}

/**
 * Find the current phase number (first non-complete phase, or last phase if all complete).
 */
export function calculateCurrentPhase(phases: PhaseData[]): number {
	if (phases.length === 0) return 1;
	
	for (const phase of phases) {
		const status = calculatePhaseStatus(phase);
		if (status !== "COMPLETE") {
			return phase.number;
		}
	}
	
	// All phases complete, return last phase
	return phases[phases.length - 1].number;
}

/**
 * Auto-update plan markdown with calculated statuses.
 * Updates frontmatter status/phase and phase status markers.
 */
export function autoUpdatePlanStatus(content: string): string {
	const parts = extractMarkdownParts(content);
	
	if (!parts.phases || parts.phases.length === 0) {
		return content; // No phases to calculate
	}
	
	let updatedContent = content;
	
	// Calculate statuses
	const calculatedPlanStatus = calculatePlanStatus(parts.phases);
	const calculatedPhase = calculateCurrentPhase(parts.phases);
	const today = new Date().toISOString().split("T")[0];
	
	// Update frontmatter status
	updatedContent = updatedContent.replace(
		/^(---\n[\s\S]*?status:\s*)([^\n]+)/m,
		`$1${calculatedPlanStatus}`,
	);
	
	// Update frontmatter phase
	updatedContent = updatedContent.replace(
		/^(---\n[\s\S]*?phase:\s*)(\d+)/m,
		`$1${calculatedPhase}`,
	);
	
	// Update frontmatter date
	updatedContent = updatedContent.replace(
		/^(---\n[\s\S]*?updated:\s*)([^\n]+)/m,
		`$1${today}`,
	);
	
	// Update each phase status marker
	for (const phase of parts.phases) {
		const calculatedStatus = calculatePhaseStatus(phase);
		// Match: ## Phase N: Name [STATUS]
		const phaseRegex = new RegExp(
			`(## Phase ${phase.number}: ${escapeRegex(phase.name)}\\s*)\\[([^\\]]+)\\]`,
		);
		updatedContent = updatedContent.replace(
			phaseRegex,
			`$1[${calculatedStatus}]`,
		);
	}
	
	return updatedContent;
}
