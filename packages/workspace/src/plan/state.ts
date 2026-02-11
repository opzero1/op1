/**
 * Plan State Management
 *
 * Active plan state, notepad helpers, slug generation, metadata generation.
 * All operations are project-scoped (stored in .opencode/workspace/).
 */

import { mkdir, readdir, stat } from "fs/promises";
import { join, basename, relative } from "path";
import { isSystemError } from "../utils.js";

// ==========================================
// TYPES
// ==========================================

export interface ActivePlanState {
	active_plan: string;
	started_at: string;
	session_ids: string[];
	plan_name: string;
	title?: string;
	description?: string;
}

export interface PlanMetadata {
	title: string;
	description: string;
}

// ==========================================
// NOTEPAD
// ==========================================

export const NOTEPAD_FILES = ["learnings.md", "issues.md", "decisions.md"] as const;
export type NotepadFile = (typeof NOTEPAD_FILES)[number];

// ==========================================
// SLUG GENERATION
// ==========================================

const ADJECTIVES = [
	"brave", "calm", "clever", "cosmic", "crisp", "curious", "eager", "gentle",
	"glowing", "happy", "hidden", "jolly", "kind", "lucky", "mighty", "misty",
	"neon", "nimble", "playful", "proud", "quick", "quiet", "shiny", "silent",
	"stellar", "sunny", "swift", "tidy", "witty",
] as const;

const NOUNS = [
	"cabin", "cactus", "canyon", "circuit", "comet", "eagle", "engine", "falcon",
	"forest", "garden", "harbor", "island", "knight", "lagoon", "meadow", "moon",
	"mountain", "nebula", "orchid", "otter", "panda", "pixel", "planet", "river",
	"rocket", "sailor", "squid", "star", "tiger", "wizard", "wolf",
] as const;

function generateSlug(): string {
	return [
		ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
		NOUNS[Math.floor(Math.random() * NOUNS.length)],
	].join("-");
}

export function generatePlanPath(plansDir: string): string {
	const timestamp = Date.now();
	const slug = generateSlug();
	const filename = `${timestamp}-${slug}.md`;
	return join(plansDir, filename);
}

export function getPlanName(planPath: string): string {
	return basename(planPath, ".md");
}

// ==========================================
// STATE OPERATIONS
// ==========================================

export function createStateManager(
	workspaceDir: string,
	plansDir: string,
	notepadsDir: string,
	activePlanPath: string,
) {
	async function readActivePlanState(): Promise<ActivePlanState | null> {
		try {
			const file = Bun.file(activePlanPath);
			if (!(await file.exists())) return null;
			const content = await file.text();
			return JSON.parse(content) as ActivePlanState;
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") return null;
			throw error;
		}
	}

	async function writeActivePlanState(state: ActivePlanState): Promise<void> {
		await mkdir(workspaceDir, { recursive: true });
		await Bun.write(activePlanPath, JSON.stringify(state, null, 2));
	}

	async function appendSessionToActivePlan(sessionID: string): Promise<void> {
		const state = await readActivePlanState();
		if (!state) return;

		if (!state.session_ids.includes(sessionID)) {
			state.session_ids.push(sessionID);
			await writeActivePlanState(state);
		}
	}

	// Notepad helpers
	async function getNotepadDir(): Promise<string | null> {
		const activePlan = await readActivePlanState();
		if (!activePlan) return null;
		return join(notepadsDir, activePlan.plan_name);
	}

	async function ensureNotepadDir(): Promise<string | null> {
		const notepadDir = await getNotepadDir();
		if (!notepadDir) return null;
		await mkdir(notepadDir, { recursive: true });
		return notepadDir;
	}

	async function readNotepadFile(file: NotepadFile): Promise<string | null> {
		const notepadDir = await getNotepadDir();
		if (!notepadDir) return null;

		try {
			const filePath = join(notepadDir, file);
			const bunFile = Bun.file(filePath);
			if (!(await bunFile.exists())) return null;
			return await bunFile.text();
		} catch (error) {
			if (isSystemError(error) && error.code === "ENOENT") return null;
			throw error;
		}
	}

	async function appendToNotepadFile(
		file: NotepadFile,
		content: string,
	): Promise<void> {
		const notepadDir = await ensureNotepadDir();
		if (!notepadDir)
			throw new Error("No active plan. Create a plan first with /plan.");

		const filePath = join(notepadDir, file);
		const timestamp = new Date().toISOString().slice(0, 10);
		const entry = `\n## ${timestamp}\n${content.trim()}\n`;

		const bunFile = Bun.file(filePath);
		if (await bunFile.exists()) {
			const existing = await bunFile.text();
			await Bun.write(filePath, existing + entry);
		} else {
			// Create file with header
			const header = `# ${file.replace(".md", "").charAt(0).toUpperCase() + file.replace(".md", "").slice(1)}\n`;
			await Bun.write(filePath, header + entry);
		}
	}

	async function listPlans(): Promise<string[]> {
		try {
			await mkdir(plansDir, { recursive: true });
			const files = await readdir(plansDir);
			return files
				.filter((f) => f.endsWith(".md"))
				.map((f) => join(plansDir, f))
				.sort()
				.reverse(); // Newest first
		} catch (error) {
			if (!isSystemError(error) || error.code !== "ENOENT") throw error;
			return [];
		}
	}

	return {
		readActivePlanState,
		writeActivePlanState,
		appendSessionToActivePlan,
		getNotepadDir,
		ensureNotepadDir,
		readNotepadFile,
		appendToNotepadFile,
		listPlans,
	};
}

// ==========================================
// METADATA GENERATION
// ==========================================

/**
 * Generate metadata (title/description) for a plan using small_model.
 * Falls back to extraction from plan content if small_model is not configured.
 */
export async function generatePlanMetadata(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	client: any,
	planContent: string,
	parentSessionID?: string,
): Promise<PlanMetadata> {
	// Fallback: Extract from plan content
	const fallbackMetadata = (): PlanMetadata => {
		// Try to extract goal from plan
		const goalMatch = planContent.match(/## Goal\n\n?([^\n#]+)/);
		const goal = goalMatch?.[1]?.trim();
		
		if (goal) {
			// Use goal as title (truncated) and first sentence as description
			const title = goal.length > 40 ? goal.slice(0, 37) + "..." : goal;
			const description = goal.length > 150 ? goal.slice(0, 147) + "..." : goal;
			return { title, description };
		}
		
		// Fallback to first non-empty line
		const firstLine = planContent.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("---")) || "Implementation Plan";
		const title = firstLine.replace(/^#+ /, "").slice(0, 40).trim();
		const description = planContent.slice(0, 150).trim() + (planContent.length > 150 ? "..." : "");
		return { title, description };
	};

	try {
		// Check if small_model is configured
		const config = await client.config.get();
		const configData = config.data as { small_model?: string } | undefined;

		if (!configData?.small_model) {
			return fallbackMetadata();
		}

		// Create a session for metadata generation
		const session = await client.session.create({
			body: {
				title: "Plan Metadata Generation",
				parentID: parentSessionID,
			},
		});

		if (!session.data?.id) {
			return fallbackMetadata();
		}

		// Prompt the small model for metadata
		const prompt = `Generate a title and description for this implementation plan.

RULES:
- Title: 3-6 words, max 40 characters, describe the main goal
- Description: 1-2 sentences, max 150 characters, summarize what will be built

PLAN CONTENT:
${planContent.slice(0, 3000)}

Respond with ONLY valid JSON in this exact format:
{"title": "Your Title Here", "description": "Your description here."}`;

		// Call with timeout
		const PROMPT_TIMEOUT_MS = 15000;
		const result = await Promise.race([
			client.session.prompt({
				path: { id: session.data.id },
				body: {
					parts: [{ type: "text" as const, text: prompt }],
				},
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Prompt timeout")), PROMPT_TIMEOUT_MS),
			),
		]);

		// Extract text from response
		const responseParts = result.data?.parts as Array<{ type: string; text?: string }> | undefined;
		const textPart = responseParts?.find((p) => p.type === "text" && typeof p.text === "string");
		
		if (!textPart?.text) {
			return fallbackMetadata();
		}

		// Parse JSON response
		const jsonMatch = textPart.text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return fallbackMetadata();
		}

		const parsed = JSON.parse(jsonMatch[0]) as { title?: string; description?: string };
		if (!parsed.title || !parsed.description) {
			return fallbackMetadata();
		}

		return {
			title: parsed.title.slice(0, 40),
			description: parsed.description.slice(0, 150),
		};
	} catch {
		return fallbackMetadata();
	}
}
