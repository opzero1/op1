export type DelegationCategory =
	| "quick"
	| "deep"
	| "visual"
	| "research"
	| "review"
	| "build"
	| "planning"
	| "general";

export type DelegationFallbackPath =
	| "none"
	| "category-default"
	| "user-subagent"
	| "keyword-fallback";

export interface DelegationRoutingTelemetry {
	detected_category: DelegationCategory;
	chosen_agent: string;
	confidence: number;
	fallback_path: DelegationFallbackPath;
}

export interface DelegationRoutingDecision {
	agent: string;
	telemetry: DelegationRoutingTelemetry;
}

interface CategoryClassification {
	category: DelegationCategory;
	confidence: number;
	fallbackPath: DelegationFallbackPath;
}

const FRONTEND_DIRECT_KEYWORDS = [
	"ui",
	"ux",
	"design",
	"css",
	"layout",
	"frontend",
	"tailwind",
	"style",
	"styling",
	"responsive",
	"accessibility",
	"a11y",
	"animation",
	"interaction",
	"visual",
	"shadcn",
	"design system",
	"design-system",
	"storybook",
] as const;

const FRONTEND_SURFACE_KEYWORDS = [
	"react",
	"next.js",
	"nextjs",
	"component",
	"page",
	"screen",
	"view",
	"dialog",
	"modal",
	"form",
] as const;

const FRONTEND_REFINEMENT_KEYWORDS = [
	"polish",
	"responsive",
	"accessibility",
	"a11y",
	"style",
	"styling",
	"layout",
	"design",
	"visual",
	"css",
	"ux",
	"ui",
	"interaction",
	"animation",
	"shadcn",
	"tailwind",
] as const;

const CATEGORY_AGENT_DEFAULTS: Record<DelegationCategory, string> = {
	quick: "coder",
	deep: "oracle",
	visual: "frontend",
	research: "researcher",
	review: "reviewer",
	build: "coder",
	planning: "oracle",
	general: "coder",
};

const CATEGORY_ORDER: DelegationCategory[] = [
	"visual",
	"research",
	"review",
	"planning",
	"deep",
	"quick",
	"build",
	"general",
];

const CATEGORY_KEYWORDS: Array<{
	category: DelegationCategory;
	keywords: string[];
}> = [
	{
		category: "visual",
		keywords: ["ui", "ux", "design", "css", "layout", "frontend"],
	},
	{
		category: "research",
		keywords: ["research", "docs", "investigate", "analyze", "compare"],
	},
	{
		category: "review",
		keywords: ["review", "audit", "security", "performance", "inspect"],
	},
	{
		category: "planning",
		keywords: ["plan", "strategy", "approach", "roadmap", "phase"],
	},
	{
		category: "deep",
		keywords: ["architecture", "debug", "root cause", "complex", "system"],
	},
	{
		category: "quick",
		keywords: ["quick", "small", "tiny", "simple", "one-line", "minor"],
	},
	{
		category: "build",
		keywords: ["implement", "ship", "code", "feature", "fix", "refactor"],
	},
];

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function clampConfidence(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function scoreCategory(text: string, keywords: string[]): number {
	let score = 0;
	for (const keyword of keywords) {
		if (!text.includes(keyword)) continue;
		score += 1;
	}
	return score;
}

function isFrontendOwnedTask(text: string): boolean {
	if (scoreCategory(text, [...FRONTEND_DIRECT_KEYWORDS]) > 0) {
		return true;
	}

	return (
		scoreCategory(text, [...FRONTEND_SURFACE_KEYWORDS]) > 0 &&
		scoreCategory(text, [...FRONTEND_REFINEMENT_KEYWORDS]) > 0
	);
}

export function parseDelegationCategory(
	value: string | undefined,
): DelegationCategory | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "quick") return "quick";
	if (normalized === "deep") return "deep";
	if (normalized === "visual") return "visual";
	if (normalized === "research") return "research";
	if (normalized === "review") return "review";
	if (normalized === "build") return "build";
	if (normalized === "planning") return "planning";
	if (normalized === "general") return "general";
	return null;
}

export function classifyDelegationCategory(
	inputText: string,
): CategoryClassification {
	const text = normalizeText(inputText);
	if (!text) {
		return {
			category: "general",
			confidence: 0.45,
			fallbackPath: "keyword-fallback",
		};
	}

	if (isFrontendOwnedTask(text)) {
		return {
			category: "visual",
			confidence: 0.9,
			fallbackPath: "none",
		};
	}

	const scores = new Map<DelegationCategory, number>();
	for (const category of CATEGORY_ORDER) {
		scores.set(category, 0);
	}

	for (const entry of CATEGORY_KEYWORDS) {
		const existing = scores.get(entry.category) ?? 0;
		scores.set(entry.category, existing + scoreCategory(text, entry.keywords));
	}

	const ranked = [...scores.entries()].sort((a, b) => {
		if (b[1] !== a[1]) return b[1] - a[1];
		return CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]);
	});

	const top = ranked[0] ?? ["general", 0];
	const second = ranked[1] ?? ["general", 0];
	const topCategory = top[0] as DelegationCategory;
	const topScore = top[1] ?? 0;
	const secondScore = second[1] ?? 0;

	if (topScore <= 0) {
		return {
			category: "general",
			confidence: 0.45,
			fallbackPath: "keyword-fallback",
		};
	}

	const confidence = clampConfidence(
		0.55 + topScore * 0.08 + (topScore - secondScore) * 0.05,
	);

	return {
		category: topCategory,
		confidence,
		fallbackPath: "none",
	};
}

export function resolveDelegationRouting(input: {
	description: string;
	prompt: string;
	command?: string;
	category?: string;
	subagentType?: string;
	autoRoute?: boolean;
}): DelegationRoutingDecision {
	const requestedCategory = parseDelegationCategory(input.category);
	const requestedAgent = input.subagentType?.trim() ?? "";
	const autoRoute = input.autoRoute ?? false;

	const classification = classifyDelegationCategory(
		[input.description, input.prompt, input.command ?? ""].join("\n"),
	);

	if (requestedAgent.length > 0) {
		const category = requestedCategory ?? classification.category;
		return {
			agent: requestedAgent,
			telemetry: {
				detected_category: category,
				chosen_agent: requestedAgent,
				confidence: requestedCategory ? 1 : classification.confidence,
				fallback_path: "user-subagent",
			},
		};
	}

	if (!autoRoute) {
		const chosenAgent =
			CATEGORY_AGENT_DEFAULTS[requestedCategory ?? classification.category];
		return {
			agent: chosenAgent,
			telemetry: {
				detected_category: requestedCategory ?? classification.category,
				chosen_agent: chosenAgent,
				confidence: requestedCategory ? 1 : classification.confidence,
				fallback_path: requestedCategory
					? "category-default"
					: "keyword-fallback",
			},
		};
	}

	if (requestedCategory) {
		const chosenAgent = CATEGORY_AGENT_DEFAULTS[requestedCategory];
		return {
			agent: chosenAgent,
			telemetry: {
				detected_category: requestedCategory,
				chosen_agent: chosenAgent,
				confidence: 1,
				fallback_path: "category-default",
			},
		};
	}

	const detectedCategory = classification.category;
	const chosenAgent = CATEGORY_AGENT_DEFAULTS[detectedCategory];
	return {
		agent: chosenAgent,
		telemetry: {
			detected_category: detectedCategory,
			chosen_agent: chosenAgent,
			confidence: classification.confidence,
			fallback_path: classification.fallbackPath,
		},
	};
}
