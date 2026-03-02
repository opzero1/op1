import { stat } from "./bun-compat.js";
import type {
	ActivePlanState,
	PlanDocRegistry,
	PlanRegistryEntry,
} from "./plan/state.js";
import { redactText, redactUnknown } from "./redaction.js";
import { isSystemError } from "./utils.js";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
	id: string;
	status: DoctorStatus;
	summary: string;
	remedy?: string;
	details?: Record<string, unknown>;
}

export interface DoctorReport {
	generated_at: string;
	status: DoctorStatus;
	checks: DoctorCheck[];
}

export interface DoctorDeps {
	directory: string;
	workspaceDir: string;
	plansDir: string;
	notepadsDir: string;
	readActivePlanState: () => Promise<ActivePlanState | null>;
	listPlanRecords: () => Promise<PlanRegistryEntry[]>;
	readPlanDocRegistry: () => Promise<PlanDocRegistry>;
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (isSystemError(error) && error.code === "ENOENT") return false;
		return false;
	}
}

function redactCheck(check: DoctorCheck): DoctorCheck {
	return {
		id: check.id,
		status: check.status,
		summary: redactText(check.summary),
		remedy: check.remedy ? redactText(check.remedy) : undefined,
		details: check.details
			? (redactUnknown(check.details) as Record<string, unknown>)
			: undefined,
	};
}

function deriveOverallStatus(checks: DoctorCheck[]): DoctorStatus {
	if (checks.some((check) => check.status === "error")) return "error";
	if (checks.some((check) => check.status === "warn")) return "warn";
	return "ok";
}

export async function runDoctorDiagnostics(
	deps: DoctorDeps,
): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];

	const workspaceExists = await directoryExists(deps.workspaceDir);
	checks.push(
		workspaceExists
			? {
					id: "workspace-dir",
					status: "ok",
					summary: "Workspace state directory is available.",
					details: { path: deps.workspaceDir },
				}
			: {
					id: "workspace-dir",
					status: "warn",
					summary: "Workspace state directory is missing.",
					remedy:
						"Run a plan/notepad tool once to initialize .opencode/workspace.",
					details: { path: deps.workspaceDir },
				},
	);

	const plansDirExists = await directoryExists(deps.plansDir);
	checks.push(
		plansDirExists
			? {
					id: "plans-dir",
					status: "ok",
					summary: "Plans directory is available.",
					details: { path: deps.plansDir },
				}
			: {
					id: "plans-dir",
					status: "warn",
					summary: "Plans directory is missing.",
					remedy: "Create a plan via /plan or plan_save mode='new'.",
					details: { path: deps.plansDir },
				},
	);

	const notepadsDirExists = await directoryExists(deps.notepadsDir);
	checks.push(
		notepadsDirExists
			? {
					id: "notepads-dir",
					status: "ok",
					summary: "Notepads directory is available.",
					details: { path: deps.notepadsDir },
				}
			: {
					id: "notepads-dir",
					status: "warn",
					summary: "Notepads directory is missing.",
					remedy: "Use notepad_write once to initialize notepad storage.",
					details: { path: deps.notepadsDir },
				},
	);

	const activePlan = await deps.readActivePlanState();
	if (!activePlan) {
		checks.push({
			id: "active-plan",
			status: "warn",
			summary: "No active plan is set.",
			remedy: "Use plan_list and plan_set_active, or create a new plan.",
		});
	} else {
		const activePlanFileExists = await Bun.file(
			activePlan.active_plan,
		).exists();
		checks.push(
			activePlanFileExists
				? {
						id: "active-plan",
						status: "ok",
						summary: "Active plan file is available.",
						details: {
							plan_name: activePlan.plan_name,
							path: activePlan.active_plan,
							sessions: activePlan.session_ids.length,
						},
					}
				: {
						id: "active-plan",
						status: "error",
						summary: "Active plan reference points to a missing file.",
						remedy:
							"Use plan_list then plan_set_active to repair active plan state.",
						details: {
							plan_name: activePlan.plan_name,
							path: activePlan.active_plan,
						},
					},
		);
	}

	const planRecords = await deps.listPlanRecords();
	const activeRecords = planRecords.filter(
		(record) => record.lifecycle === "active",
	);
	const missingPlanFiles: string[] = [];

	for (const record of planRecords) {
		const exists = await Bun.file(record.path).exists();
		if (!exists) missingPlanFiles.push(record.path);
	}

	if (activeRecords.length > 1) {
		checks.push({
			id: "plan-registry",
			status: "error",
			summary: "Plan registry has multiple active plans.",
			remedy:
				"Archive or deactivate extra plans so only one active plan remains.",
			details: {
				active_plan_count: activeRecords.length,
			},
		});
	} else if (missingPlanFiles.length > 0) {
		checks.push({
			id: "plan-registry",
			status: "warn",
			summary: "Plan registry references missing files.",
			remedy:
				"Run plan_list/plan_set_active to sync and repair registry references.",
			details: {
				missing_files: missingPlanFiles,
			},
		});
	} else {
		checks.push({
			id: "plan-registry",
			status: "ok",
			summary: "Plan registry state is consistent.",
			details: {
				total_plans: planRecords.length,
				active_plans: activeRecords.length,
			},
		});
	}

	const docRegistry = await deps.readPlanDocRegistry();
	const missingDocs: string[] = [];
	for (const doc of Object.values(docRegistry.docs)) {
		const exists = await Bun.file(doc.path).exists();
		if (!exists) missingDocs.push(doc.path);
	}

	checks.push(
		missingDocs.length === 0
			? {
					id: "linked-docs",
					status: "ok",
					summary: "All linked docs resolve successfully.",
					details: { linked_docs: Object.keys(docRegistry.docs).length },
				}
			: {
					id: "linked-docs",
					status: "warn",
					summary: "Some linked docs are missing.",
					remedy:
						"Use plan_doc_list and relink or remove stale doc references.",
					details: { missing_docs: missingDocs },
				},
	);

	const status = deriveOverallStatus(checks);
	return {
		generated_at: new Date().toISOString(),
		status,
		checks,
	};
}

export function redactDoctorReport(report: DoctorReport): DoctorReport {
	return {
		generated_at: report.generated_at,
		status: report.status,
		checks: report.checks.map(redactCheck),
	};
}

function statusIcon(status: DoctorStatus): string {
	if (status === "ok") return "OK";
	if (status === "warn") return "WARN";
	return "ERROR";
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = [];
	lines.push(`# Workspace Doctor`);
	lines.push(`generated_at: ${report.generated_at}`);
	lines.push(`status: ${report.status}`);
	lines.push("");

	for (const check of report.checks) {
		lines.push(`- [${statusIcon(check.status)}] ${check.id}: ${check.summary}`);
		if (check.remedy) {
			lines.push(`  remedy: ${check.remedy}`);
		}
		if (check.details && Object.keys(check.details).length > 0) {
			lines.push(`  details: ${JSON.stringify(check.details)}`);
		}
	}

	return lines.join("\n");
}
