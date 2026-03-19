import { truncateText } from "../serializer/shared.js";
import type {
	GroundingBundle,
	RepromptDecision,
	RepromptTaskClass,
} from "../types.js";

export interface BuildRetryPromptInput {
	taskSummary: string;
	failureSummary: string;
	bundle: GroundingBundle;
	decision: RepromptDecision;
	retryDiagnostics?: string[];
	maxPromptChars?: number;
}

export function buildRetryPrompt(input: BuildRetryPromptInput): string {
	const sections = [
		"You are retrying a failed implementation step with bounded local evidence only.",
		"",
		`Task summary: ${input.taskSummary}`,
		`Failure summary: ${input.failureSummary}`,
		`Decision: ${input.decision.action}`,
		"",
		"Evidence slices:",
		...input.bundle.evidenceSlices.map(
			(slice) => `- ${slice.provenance} :: ${truncateText(slice.excerpt, 320)}`,
		),
	];

	if (input.retryDiagnostics && input.retryDiagnostics.length > 0) {
		sections.push(
			"",
			"Retry diagnostics:",
			...input.retryDiagnostics.map((item) => `- ${item}`),
		);
	}

	sections.push(
		"",
		"Instructions:",
		"- Use only the evidence above and do not request broad repository dumps.",
		"- If you produce an edit, keep it deterministic and scoped to the cited files.",
		"- If the evidence is insufficient, say so explicitly instead of guessing.",
	);

	return truncateText(sections.join("\n"), input.maxPromptChars ?? 12_000);
}

function sharedContracts(): string[] {
	return [
		"<output_contract>",
		"- Return exactly the sections needed for the task.",
		"- Keep the answer concise, grounded, and information-dense.",
		"- Do not restate the user request unless needed for clarity.",
		"</output_contract>",
		"",
		"<default_follow_through_policy>",
		"- If intent is clear and the next step is reversible and low-risk, proceed without asking.",
		"- Ask only when the next step is irreversible, has external side effects, or needs missing sensitive information.",
		"- If proceeding, briefly state what you did and what remains optional.",
		"</default_follow_through_policy>",
		"",
		"<instruction_priority>",
		"- Follow developer and system instructions before user style preferences.",
		"- Preserve safety, honesty, privacy, and permission constraints.",
		"- Apply newer user instructions when they conflict with earlier user instructions.",
		"</instruction_priority>",
		"",
		"<missing_context_gating>",
		"- Do not guess required context.",
		"- Prefer bounded lookup and the provided evidence before asking a clarifying question.",
		"- If context is still missing, state the exact gap and use a reversible next step.",
		"</missing_context_gating>",
	];
}

function codingContracts(): string[] {
	return [
		"<tool_persistence_rules>",
		"- Use tools when they materially improve correctness or grounding.",
		"- Resolve prerequisite discovery before edits or decisions.",
		"- If lookup results are empty or suspiciously narrow, retry with a different bounded strategy.",
		"</tool_persistence_rules>",
		"",
		"<dependency_checks>",
		"- Resolve prerequisite context before taking downstream actions.",
		"- Parallelize only independent lookups; keep dependent steps sequential.",
		"</dependency_checks>",
		"",
		"<completeness_contract>",
		"- Treat the task as incomplete until requested work is implemented or explicitly marked blocked.",
		"- Keep track of required deliverables and verify coverage before finishing.",
		"</completeness_contract>",
		"",
		"<verification_loop>",
		"- Before finalizing, check correctness, grounding, formatting, and safety.",
		"- Run relevant verification steps instead of assuming the change works.",
		"</verification_loop>",
		"",
		"<terminal_tool_hygiene>",
		"- Use dedicated edit/read/search tools when available.",
		"- Keep shell usage limited to terminal tasks such as tests, builds, or git.",
		"</terminal_tool_hygiene>",
	];
}

function researchContracts(): string[] {
	return [
		"<grounding_rules>",
		"- Base claims only on the provided context and retrieved evidence.",
		"- Label inferences when they are not directly supported by evidence.",
		"- If sources conflict, state the conflict explicitly.",
		"</grounding_rules>",
		"",
		"<citation_rules>",
		"- Cite only retrieved evidence when citations are needed.",
		"- Do not fabricate sources or identifiers.",
		"</citation_rules>",
		"",
		"<verification_loop>",
		"- Confirm that each major claim is supported by retrieved evidence before finalizing.",
		"</verification_loop>",
	];
}

function planContracts(): string[] {
	return [
		"<completeness_contract>",
		"- Cover every requested deliverable or mark it blocked with the exact missing input.",
		"- Keep the output ordered, compact, and directly actionable.",
		"- Make the goal, chosen repo pattern, blast radius, success criteria, failure criteria, and test plan explicit before finalizing.",
		"</completeness_contract>",
		"",
		"<confirmation_gates>",
		"- Prefer structured question prompts when the answer can be constrained cleanly.",
		"- Save a draft before promotion when the workflow supports draft/confirm/promote plan lifecycles.",
		"- If critical context remains ambiguous, stop and ask instead of saving a weak plan.",
		"</confirmation_gates>",
		"",
		"<verification_loop>",
		"- Check that dependencies, blockers, blast radius, success criteria, failure criteria, and test expectations are explicit before finalizing.",
		"</verification_loop>",
	];
}

function contractsForTaskClass(taskClass: RepromptTaskClass): string[] {
	if (
		taskClass === "implementation" ||
		taskClass === "debug" ||
		taskClass === "test" ||
		taskClass === "review"
	) {
		return [...sharedContracts(), "", ...codingContracts()];
	}

	if (taskClass === "plan") {
		return [...sharedContracts(), "", ...planContracts()];
	}

	return [...sharedContracts(), "", ...researchContracts()];
}

function reasoningGuidanceForTaskClass(taskClass: RepromptTaskClass): string[] {
	const effort =
		taskClass === "plan" || taskClass === "research"
			? "medium"
			: taskClass === "question"
				? "low"
				: "medium";

	return [
		"<reasoning_effort_guidance>",
		`- Prefer ${effort} reasoning effort for this task shape; do not over-think simple formatting or lookup work.`,
		"- Spend extra effort only on ambiguity, contradictions, or verification-critical decisions.",
		"</reasoning_effort_guidance>",
		"",
		"<model_tier_guidance>",
		"- Keep the execution order explicit enough for smaller models while staying compact for stronger models.",
		"- Do not rely on implicit next steps when the task depends on tool use, verification, or omission handling.",
		"</model_tier_guidance>",
	];
}

export interface BuildCompilerPromptInput {
	originalPrompt: string;
	taskSummary: string;
	failureSummary: string;
	taskClass: RepromptTaskClass;
	bundle: GroundingBundle;
	decision: RepromptDecision;
	successCriteria?: string[];
	omissionReasons?: string[];
	retryDiagnostics?: string[];
	maxPromptChars?: number;
}

export function buildCompilerPrompt(input: BuildCompilerPromptInput): string {
	const sections = [
		"You are retrying a terse request with bounded local evidence and must rewrite it into a stronger GPT-5.4-ready execution prompt.",
		"",
		"<task_brief>",
		`Original prompt: ${input.originalPrompt}`,
		`Normalized task: ${input.taskSummary}`,
		`Failure summary: ${input.failureSummary}`,
		`Task class: ${input.taskClass}`,
		`Decision: ${input.decision.action}`,
		"</task_brief>",
	];

	if (input.successCriteria && input.successCriteria.length > 0) {
		sections.push(
			"",
			"<success_criteria>",
			...input.successCriteria.map((item) => `- ${item}`),
			"</success_criteria>",
		);
	}

	sections.push(
		"",
		"<grounding_context>",
		"Use only this local evidence when grounding the response:",
		...input.bundle.evidenceSlices.map(
			(slice) => `- ${slice.provenance} :: ${truncateText(slice.excerpt, 320)}`,
		),
		"</grounding_context>",
	);

	if (input.omissionReasons && input.omissionReasons.length > 0) {
		sections.push(
			"",
			"<missing_context>",
			...input.omissionReasons.map((item) => `- ${item}`),
			"</missing_context>",
		);
	}

	if (input.retryDiagnostics && input.retryDiagnostics.length > 0) {
		sections.push(
			"",
			"<retry_diagnostics>",
			...input.retryDiagnostics.map((item) => `- ${item}`),
			"</retry_diagnostics>",
		);
	}

	sections.push(
		"",
		"<rewrite_instructions>",
		"- Upgrade the terse request into a concrete, structured prompt that fits the task class.",
		"- Preserve the original intent while adding only grounded context, explicit contracts, and safe defaults.",
		"- Do not broaden scope with repository dumps, invented requirements, or unsupported claims.",
		"</rewrite_instructions>",
		"",
		...reasoningGuidanceForTaskClass(input.taskClass),
		"",
		...contractsForTaskClass(input.taskClass),
	);

	return truncateText(sections.join("\n"), input.maxPromptChars ?? 12_000);
}
