import { truncateText } from "../serializer/shared.js";
import type {
	GroundingBundle,
	RepromptDecision,
	RepromptTaskClass,
} from "../types.js";

export const REPROMPT_PROMPT_MARKER = '<reprompt-origin source="reprompt" />';

export function hasRepromptPromptMarker(value: string): boolean {
	return value.includes(REPROMPT_PROMPT_MARKER);
}

function finalizeRepromptPrompt(
	sections: string[],
	maxPromptChars: number,
): string {
	return truncateText(
		[REPROMPT_PROMPT_MARKER, "", ...sections].join("\n"),
		maxPromptChars,
	);
}

function sharedContracts(): string[] {
	return [
		"<output_contract>",
		"- Return exactly the sections needed for the task.",
		"- Keep the answer concise, grounded, and information-dense.",
		"- Do not restate the user request unless needed for clarity.",
		"</output_contract>",
		"",
		"<verbosity_controls>",
		"- Prefer concise, information-dense writing.",
		"- Avoid repeating the user's request.",
		"- Keep progress updates brief without dropping required evidence or verification details.",
		"</verbosity_controls>",
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
		"- Preserve earlier instructions that do not conflict.",
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
		"- Do not stop early when another bounded tool call is likely to improve correctness or completeness.",
		"- If lookup results are empty or suspiciously narrow, retry with a different bounded strategy.",
		"</tool_persistence_rules>",
		"",
		"<dependency_checks>",
		"- Resolve prerequisite context before taking downstream actions.",
		"- Parallelize only independent lookups; keep dependent steps sequential.",
		"</dependency_checks>",
		"",
		"<empty_result_recovery>",
		"- If retrieval is empty, partial, or suspiciously narrow, try one or two fallback strategies before concluding nothing exists.",
		"- Prefer alternate query wording, broader filters, prerequisite lookups, or another bounded source over a broad repo dump.",
		"</empty_result_recovery>",
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
		"- Attach citations to the claims they support instead of collecting them only at the end.",
		"</citation_rules>",
		"",
		"<empty_result_recovery>",
		"- If retrieval is empty or suspiciously narrow, try one or two bounded fallback strategies before concluding nothing exists.",
		"</empty_result_recovery>",
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

export interface BuildFailClosedPromptInput {
	originalPrompt: string;
	taskSummary: string;
	taskClass: RepromptTaskClass;
	reason: string;
	omissionReasons?: string[];
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

	return finalizeRepromptPrompt(sections, input.maxPromptChars ?? 12_000);
}

export function buildFailClosedPrompt(
	input: BuildFailClosedPromptInput,
): string {
	const sections = [
		"The original user request is too ambiguous to rewrite into a grounded execution prompt safely.",
		"",
		"<task_brief>",
		`Original prompt: ${input.originalPrompt}`,
		`Normalized task: ${input.taskSummary}`,
		`Task class: ${input.taskClass}`,
		`Reason: ${input.reason}`,
		"</task_brief>",
	];

	if (input.omissionReasons && input.omissionReasons.length > 0) {
		sections.push(
			"",
			"<missing_context>",
			...input.omissionReasons.map((item) => `- ${item}`),
			"</missing_context>",
		);
	}

	sections.push(
		"",
		"<fail_closed_instructions>",
		"- Do not implement, rewrite further, or assume missing context.",
		"- Ask exactly one targeted clarification question that resolves the highest-leverage ambiguity.",
		"- Keep the question concise and wait for the user's answer.",
		"</fail_closed_instructions>",
	);

	return finalizeRepromptPrompt(sections, input.maxPromptChars ?? 12_000);
}
