import type { RepromptTaskClass, RetryTrigger } from "../types.js";

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"best",
	"build",
	"by",
	"for",
	"from",
	"help",
	"how",
	"into",
	"need",
	"prompt",
	"task",
	"that",
	"the",
	"this",
	"user",
	"with",
]);

const CLASS_KEYWORDS: Array<{
	taskClass: RepromptTaskClass;
	patterns: RegExp[];
}> = [
	{
		taskClass: "debug",
		patterns: [
			/\bbug\b/i,
			/\bdebug\b/i,
			/\berror\b/i,
			/\bfail(?:ing|ed)?\b/i,
			/\bfix\b/i,
		],
	},
	{
		taskClass: "test",
		patterns: [/\bcoverage\b/i, /\btest(?:s|ing)?\b/i, /\bverify\b/i],
	},
	{
		taskClass: "review",
		patterns: [/\baudit\b/i, /\breview\b/i, /\brisk\b/i],
	},
	{
		taskClass: "plan",
		patterns: [/\bapproach\b/i, /\bplan\b/i, /\bstrategy\b/i],
	},
	{
		taskClass: "research",
		patterns: [/\bcompare\b/i, /\binvestigate\b/i, /\bresearch\b/i],
	},
	{
		taskClass: "question",
		patterns: [/^why\b/i, /^what\b/i, /^how\b/i, /\bexplain\b/i],
	},
];

function normalizeTaskTypeHint(value?: string): RepromptTaskClass | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "implementation" ||
		normalized === "debug" ||
		normalized === "test" ||
		normalized === "review" ||
		normalized === "question" ||
		normalized === "plan" ||
		normalized === "research"
	) {
		return normalized;
	}
	return null;
}

export function classifyRepromptTask(input: {
	promptText: string;
	failureSummary: string;
	taskTypeHint?: string;
	trigger: RetryTrigger;
}): RepromptTaskClass {
	const hinted = normalizeTaskTypeHint(input.taskTypeHint);
	if (hinted) return hinted;

	const combined = `${input.promptText}\n${input.failureSummary}`.trim();
	for (const group of CLASS_KEYWORDS) {
		if (group.patterns.some((pattern) => pattern.test(combined))) {
			return group.taskClass;
		}
	}

	if (input.trigger.failureClass === "grounding") {
		return "implementation";
	}

	if (input.trigger.failureClass === "patch-recovery") {
		return "debug";
	}

	return "implementation";
}

function sanitizeToken(token: string): string {
	return token.replace(/^[^A-Za-z0-9_./-]+|[^A-Za-z0-9_./-]+$/g, "");
}

export function extractPromptHints(input: {
	promptText: string;
	limit?: number;
}): {
	paths: string[];
	searchTerms: string[];
	symbols: string[];
} {
	const limit = input.limit ?? 4;
	const rawTokens = input.promptText.match(/[A-Za-z0-9_./-]{3,}/g) ?? [];
	const paths: string[] = [];
	const searchTerms: string[] = [];
	const symbols: string[] = [];
	const seenPaths = new Set<string>();
	const seenTerms = new Set<string>();
	const seenSymbols = new Set<string>();

	for (const rawToken of rawTokens) {
		const token = sanitizeToken(rawToken);
		if (!token) continue;

		if ((token.includes("/") || token.includes(".")) && !seenPaths.has(token)) {
			seenPaths.add(token);
			paths.push(token);
			continue;
		}

		const lowered = token.toLowerCase();
		if (
			!STOP_WORDS.has(lowered) &&
			/[a-z]/i.test(token) &&
			!seenTerms.has(lowered)
		) {
			seenTerms.add(lowered);
			searchTerms.push(lowered);
		}

		if (
			(/[A-Z]/.test(token) || token.includes("_") || token.includes("-")) &&
			!seenSymbols.has(token)
		) {
			seenSymbols.add(token);
			symbols.push(token);
		}
	}

	return {
		paths: paths.slice(0, limit),
		searchTerms: searchTerms.slice(0, limit),
		symbols: symbols.slice(0, limit),
	};
}
