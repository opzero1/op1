/**
 * Plan Schema & Validation
 *
 * Zod schemas for plan structure, markdown parsing, and validation logic.
 */

import { z } from "zod";

// ==========================================
// ZOD SCHEMAS
// ==========================================

export const PhaseStatus = z.enum(["PENDING", "IN PROGRESS", "COMPLETE", "BLOCKED"]);

export const TaskSchema = z.object({
	id: z
		.string()
		.regex(/^\d+\.\d+$/, "Task ID must be hierarchical (e.g., '2.1')"),
	checked: z.boolean(),
	content: z.string().min(1, "Task content cannot be empty"),
	isCurrent: z.boolean().optional(),
	citation: z
		.string()
		.regex(
			/^ref:[a-z]+-[a-z]+-[a-z]+$/,
			"Citation must be ref:word-word-word format",
		)
		.optional(),
});

export const PhaseSchema = z.object({
	number: z.number().int().positive(),
	name: z.string().min(1, "Phase name cannot be empty"),
	status: PhaseStatus,
	tasks: z.array(TaskSchema).min(1, "Phase must have at least one task"),
});

export const FrontmatterSchema = z.object({
	status: z.enum(["not-started", "in-progress", "complete", "blocked"]),
	phase: z.number().int().positive(),
	updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
});

export const PlanSchema = z.object({
	frontmatter: FrontmatterSchema,
	goal: z.string().min(10, "Goal must be at least 10 characters"),
	context: z
		.array(
			z.object({
				decision: z.string(),
				rationale: z.string(),
				source: z.string(),
			}),
		)
		.optional(),
	phases: z.array(PhaseSchema).min(1, "Plan must have at least one phase"),
});

// ==========================================
// TYPES
// ==========================================

export type ParseResult =
	| { ok: true; data: z.infer<typeof PlanSchema>; warnings: string[] }
	| { ok: false; error: string; hint: string };

export interface ExtractedParts {
	frontmatter: Record<string, string | number> | null;
	goal: string | null;
	phases: Array<{
		number: number;
		name: string;
		status: string;
		tasks: Array<{
			id: string;
			checked: boolean;
			content: string;
			isCurrent: boolean;
			citation?: string;
		}>;
	}>;
}

// ==========================================
// PARSING
// ==========================================

export function extractMarkdownParts(content: string): ExtractedParts {
	// Guard against non-string input
	if (typeof content !== "string") {
		return { frontmatter: null, goal: null, phases: [] };
	}
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
	let frontmatter: Record<string, string | number> | null = null;

	if (fmMatch) {
		frontmatter = {};
		const fmLines = fmMatch[1].split("\n");
		for (const line of fmLines) {
			const [key, ...valueParts] = line.split(":");
			if (key && valueParts.length > 0) {
				const value = valueParts.join(":").trim();
				frontmatter[key.trim()] =
					key.trim() === "phase" ? parseInt(value, 10) : value;
			}
		}
	}

	// Match ## Goal followed by optional blank lines, then capture the goal text
	const goalMatch = content.match(/## Goal\n\n?([^\n#]+)/);
	const goal = goalMatch?.[1]?.trim() || null;

	const phases: ExtractedParts["phases"] = [];
	const phaseRegex =
		/## Phase (\d+): ([^[]+)\[([^\]]+)\]\n([\s\S]*?)(?=## Phase \d+:|## Notes|## Blockers|$)/g;

	let phaseMatch = phaseRegex.exec(content);
	while (phaseMatch !== null) {
		const phaseNum = parseInt(phaseMatch[1], 10);
		const phaseName = phaseMatch[2].trim();
		const phaseStatus = phaseMatch[3].trim();
		const phaseContent = phaseMatch[4];

		const tasks: ExtractedParts["phases"][0]["tasks"] = [];
		const taskRegex =
			/- \[([ x])\] (\*\*)?(\d+\.\d+) ([^←\n]+)(← CURRENT)?.*?(`ref:[a-z]+-[a-z]+-[a-z]+`)?/g;

		let taskMatch = taskRegex.exec(phaseContent);
		while (taskMatch !== null) {
			tasks.push({
				id: taskMatch[3],
				checked: taskMatch[1] === "x",
				content: taskMatch[4].trim().replace(/\*\*/g, ""),
				isCurrent: !!taskMatch[5],
				citation: taskMatch[6]?.replace(/`/g, ""),
			});
			taskMatch = taskRegex.exec(phaseContent);
		}

		phases.push({
			number: phaseNum,
			name: phaseName,
			status: phaseStatus,
			tasks,
		});
		phaseMatch = phaseRegex.exec(content);
	}

	return { frontmatter, goal, phases };
}

// ==========================================
// VALIDATION
// ==========================================

function formatZodErrors(error: z.ZodError): string {
	const errorMessages: string[] = [];

	for (const issue of error.issues) {
		const path = issue.path.length > 0 ? `[${issue.path.join(".")}]` : "[root]";
		let message = issue.message;
		// Handle invalid_value (zod v4) which replaced invalid_enum_value
		if (issue.code === "invalid_value") {
			const values = (issue as { values?: unknown[] }).values;
			const received = (issue as { received?: unknown }).received;
			message = `Invalid value "${received}". Expected: ${values?.join(" | ") ?? "valid value"}`;
		} else if (
			issue.code === "invalid_type" &&
			(issue as { received?: unknown }).received === "null"
		) {
			message = "Required field missing";
		}
		errorMessages.push(`${path}: ${message}`);
	}

	return errorMessages.join("\n");
}

export function parsePlanMarkdown(content: string): ParseResult {
	const skillHint = "Load skill('plan-protocol') for the full format spec.";

	if (typeof content !== "string") {
		return {
			ok: false,
			error: `Expected markdown string, received ${typeof content}`,
			hint: skillHint,
		};
	}

	if (!content.trim()) {
		return {
			ok: false,
			error: "Empty content provided",
			hint: skillHint,
		};
	}

	const parts = extractMarkdownParts(content);
	const candidate = {
		frontmatter: parts.frontmatter,
		goal: parts.goal,
		phases: parts.phases,
	};

	const result = PlanSchema.safeParse(candidate);
	if (!result.success) {
		return {
			ok: false,
			error: formatZodErrors(result.error),
			hint: skillHint,
		};
	}

	const warnings: string[] = [];
	let currentCount = 0;
	let inProgressCount = 0;

	for (const phase of result.data.phases) {
		if (phase.status === "IN PROGRESS") inProgressCount++;
		for (const task of phase.tasks) {
			if (task.isCurrent) currentCount++;
		}
	}

	if (currentCount > 1) {
		return {
			ok: false,
			error: `Multiple tasks marked ← CURRENT (found ${currentCount}). Only one task may be current.`,
			hint: skillHint,
		};
	}

	if (inProgressCount > 1) {
		warnings.push(
			"Multiple phases marked IN PROGRESS. Consider focusing on one phase at a time.",
		);
	}

	return { ok: true, data: result.data, warnings };
}

export function formatParseError(error: string, hint: string): string {
	return `❌ Plan validation failed:\n\n${error}\n\n💡 ${hint}`;
}
