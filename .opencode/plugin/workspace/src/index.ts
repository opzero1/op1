import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type Plugin, tool } from "@opencode-ai/plugin"
import { z } from "zod"

// ==========================================
// PROJECT ID CALCULATION
// ==========================================

/**
 * Get project ID from git root commit hash (cross-worktree consistent)
 */
async function getProjectId(directory: string): Promise<string> {
	try {
		const { execFile } = await import("node:child_process")
		const { promisify } = await import("node:util")
		const execFileAsync = promisify(execFile)

		const { stdout } = await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], {
			cwd: directory,
			encoding: "utf8",
		})
		return stdout.trim().slice(0, 12)
	} catch {
		// Fallback to directory hash if not a git repo
		const hash = await import("node:crypto")
		return hash.createHash("sha256").update(directory).digest("hex").slice(0, 12)
	}
}

// ==========================================
// PLAN SCHEMA & VALIDATION
// ==========================================

const PhaseStatus = z.enum(["PENDING", "IN PROGRESS", "COMPLETE", "BLOCKED"])

const TaskSchema = z.object({
	id: z.string().regex(/^\d+\.\d+$/, "Task ID must be hierarchical (e.g., '2.1')"),
	checked: z.boolean(),
	content: z.string().min(1, "Task content cannot be empty"),
	isCurrent: z.boolean().optional(),
	citation: z
		.string()
		.regex(/^ref:[a-z]+-[a-z]+-[a-z]+$/, "Citation must be ref:word-word-word format")
		.optional(),
})

const PhaseSchema = z.object({
	number: z.number().int().positive(),
	name: z.string().min(1, "Phase name cannot be empty"),
	status: PhaseStatus,
	tasks: z.array(TaskSchema).min(1, "Phase must have at least one task"),
})

const FrontmatterSchema = z.object({
	status: z.enum(["not-started", "in-progress", "complete", "blocked"]),
	phase: z.number().int().positive(),
	updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
})

const PlanSchema = z.object({
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
})

type ParseResult =
	| { ok: true; data: z.infer<typeof PlanSchema>; warnings: string[] }
	| { ok: false; error: string; hint: string }

interface ExtractedParts {
	frontmatter: Record<string, string | number> | null
	goal: string | null
	phases: Array<{
		number: number
		name: string
		status: string
		tasks: Array<{
			id: string
			checked: boolean
			content: string
			isCurrent: boolean
			citation?: string
		}>
	}>
}

function extractMarkdownParts(content: string): ExtractedParts {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
	let frontmatter: Record<string, string | number> | null = null

	if (fmMatch) {
		frontmatter = {}
		const fmLines = fmMatch[1].split("\n")
		for (const line of fmLines) {
			const [key, ...valueParts] = line.split(":")
			if (key && valueParts.length > 0) {
				const value = valueParts.join(":").trim()
				frontmatter[key.trim()] = key.trim() === "phase" ? parseInt(value, 10) : value
			}
		}
	}

	// Match ## Goal followed by optional blank lines, then capture the goal text
	const goalMatch = content.match(/## Goal\n\n?([^\n#]+)/)
	const goal = goalMatch?.[1]?.trim() || null

	const phases: ExtractedParts["phases"] = []
	const phaseRegex =
		/## Phase (\d+): ([^[]+)\[([^\]]+)\]\n([\s\S]*?)(?=## Phase \d+:|## Notes|## Blockers|$)/g

	let phaseMatch = phaseRegex.exec(content)
	while (phaseMatch !== null) {
		const phaseNum = parseInt(phaseMatch[1], 10)
		const phaseName = phaseMatch[2].trim()
		const phaseStatus = phaseMatch[3].trim()
		const phaseContent = phaseMatch[4]

		const tasks: ExtractedParts["phases"][0]["tasks"] = []
		const taskRegex =
			/- \[([ x])\] (\*\*)?(\d+\.\d+) ([^←\n]+)(← CURRENT)?.*?(`ref:[a-z]+-[a-z]+-[a-z]+`)?/g

		let taskMatch = taskRegex.exec(phaseContent)
		while (taskMatch !== null) {
			tasks.push({
				id: taskMatch[3],
				checked: taskMatch[1] === "x",
				content: taskMatch[4].trim().replace(/\*\*/g, ""),
				isCurrent: !!taskMatch[5],
				citation: taskMatch[6]?.replace(/`/g, ""),
			})
			taskMatch = taskRegex.exec(phaseContent)
		}

		phases.push({
			number: phaseNum,
			name: phaseName,
			status: phaseStatus,
			tasks,
		})
		phaseMatch = phaseRegex.exec(content)
	}

	return { frontmatter, goal, phases }
}

function formatZodErrors(error: z.ZodError): string {
	const errorMessages: string[] = []

	for (const issue of error.issues) {
		const path = issue.path.length > 0 ? `[${issue.path.join(".")}]` : "[root]"
		let message = issue.message
		if (issue.code === "invalid_enum_value") {
			const options = (issue as { options?: unknown[] }).options
			const received = (issue as { received?: unknown }).received
			message = `Invalid value "${received}". Expected: ${options?.join(" | ") ?? "valid value"}`
		} else if (issue.code === "invalid_type" && (issue as { received?: unknown }).received === "null") {
			message = "Required field missing"
		}
		errorMessages.push(`${path}: ${message}`)
	}

	return errorMessages.join("\n")
}

function parsePlanMarkdown(content: string): ParseResult {
	const skillHint = "Load skill('plan-protocol') for the full format spec."

	if (typeof content !== "string") {
		return {
			ok: false,
			error: `Expected markdown string, received ${typeof content}`,
			hint: skillHint,
		}
	}

	if (!content.trim()) {
		return {
			ok: false,
			error: "Empty content provided",
			hint: skillHint,
		}
	}

	const parts = extractMarkdownParts(content)
	const candidate = {
		frontmatter: parts.frontmatter,
		goal: parts.goal,
		phases: parts.phases,
	}

	const result = PlanSchema.safeParse(candidate)
	if (!result.success) {
		return {
			ok: false,
			error: formatZodErrors(result.error),
			hint: skillHint,
		}
	}

	const warnings: string[] = []
	let currentCount = 0
	let inProgressCount = 0

	for (const phase of result.data.phases) {
		if (phase.status === "IN PROGRESS") inProgressCount++
		for (const task of phase.tasks) {
			if (task.isCurrent) currentCount++
		}
	}

	if (currentCount > 1) {
		return {
			ok: false,
			error: `Multiple tasks marked ← CURRENT (found ${currentCount}). Only one task may be current.`,
			hint: skillHint,
		}
	}

	if (inProgressCount > 1) {
		warnings.push("Multiple phases marked IN PROGRESS. Consider focusing on one phase at a time.")
	}

	return { ok: true, data: result.data, warnings }
}

function formatParseError(error: string, hint: string): string {
	return `❌ Plan validation failed:

${error}

💡 ${hint}`
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

// ==========================================
// PLAN STATE MANAGEMENT (Project-Scoped)
// ==========================================

interface ActivePlanState {
	active_plan: string
	started_at: string
	session_ids: string[]
	plan_name: string
}

// Slug generation (from opencode-source)
const ADJECTIVES = [
	"brave",
	"calm",
	"clever",
	"cosmic",
	"crisp",
	"curious",
	"eager",
	"gentle",
	"glowing",
	"happy",
	"hidden",
	"jolly",
	"kind",
	"lucky",
	"mighty",
	"misty",
	"neon",
	"nimble",
	"playful",
	"proud",
	"quick",
	"quiet",
	"shiny",
	"silent",
	"stellar",
	"sunny",
	"swift",
	"tidy",
	"witty",
] as const

const NOUNS = [
	"cabin",
	"cactus",
	"canyon",
	"circuit",
	"comet",
	"eagle",
	"engine",
	"falcon",
	"forest",
	"garden",
	"harbor",
	"island",
	"knight",
	"lagoon",
	"meadow",
	"moon",
	"mountain",
	"nebula",
	"orchid",
	"otter",
	"panda",
	"pixel",
	"planet",
	"river",
	"rocket",
	"sailor",
	"squid",
	"star",
	"tiger",
	"wizard",
	"wolf",
] as const

function generateSlug(): string {
	return [
		ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
		NOUNS[Math.floor(Math.random() * NOUNS.length)],
	].join("-")
}

function generatePlanPath(plansDir: string): string {
	const timestamp = Date.now()
	const slug = generateSlug()
	const filename = `${timestamp}-${slug}.md`
	return path.join(plansDir, filename)
}

function getPlanName(planPath: string): string {
	return path.basename(planPath, ".md")
}

export const WorkspacePlugin: Plugin = async (ctx) => {
	const { directory } = ctx

	const projectId = await getProjectId(directory)

	// Legacy session-scoped directory (for migration fallback)
	const legacyBaseDir = path.join(os.homedir(), ".local", "share", "opencode", "workspace", projectId)

	// New project-scoped directories
	const workspaceDir = path.join(directory, ".opencode", "workspace")
	const plansDir = path.join(workspaceDir, "plans")
	const notepadsDir = path.join(workspaceDir, "notepads")
	const activePlanPath = path.join(workspaceDir, "active-plan.json")

	// Notepad file types
	const NOTEPAD_FILES = ["learnings.md", "issues.md", "decisions.md"] as const
	type NotepadFile = (typeof NOTEPAD_FILES)[number]

	async function getRootSessionID(sessionID?: string): Promise<string> {
		if (!sessionID) {
			throw new Error("sessionID is required to resolve root session scope")
		}

		let currentID = sessionID
		for (let depth = 0; depth < 10; depth++) {
			const session = await ctx.client.session.get({
				path: { id: currentID },
			})

			if (!session.data?.parentID) {
				return currentID
			}

			currentID = session.data.parentID
		}

		throw new Error("Failed to resolve root session: maximum traversal depth exceeded")
	}

	async function readActivePlanState(): Promise<ActivePlanState | null> {
		try {
			const content = await fs.readFile(activePlanPath, "utf8")
			return JSON.parse(content) as ActivePlanState
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return null
			throw error
		}
	}

	async function writeActivePlanState(state: ActivePlanState): Promise<void> {
		await fs.mkdir(workspaceDir, { recursive: true })
		await fs.writeFile(activePlanPath, JSON.stringify(state, null, 2), "utf8")
	}

	async function appendSessionToActivePlan(sessionID: string): Promise<void> {
		const state = await readActivePlanState()
		if (!state) return

		if (!state.session_ids.includes(sessionID)) {
			state.session_ids.push(sessionID)
			await writeActivePlanState(state)
		}
	}

	// ==========================================
	// NOTEPAD HELPERS
	// ==========================================

	async function getNotepadDir(): Promise<string | null> {
		const activePlan = await readActivePlanState()
		if (!activePlan) return null
		return path.join(notepadsDir, activePlan.plan_name)
	}

	async function ensureNotepadDir(): Promise<string | null> {
		const notepadDir = await getNotepadDir()
		if (!notepadDir) return null
		await fs.mkdir(notepadDir, { recursive: true })
		return notepadDir
	}

	async function readNotepadFile(file: NotepadFile): Promise<string | null> {
		const notepadDir = await getNotepadDir()
		if (!notepadDir) return null

		try {
			return await fs.readFile(path.join(notepadDir, file), "utf8")
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return null
			throw error
		}
	}

	async function appendToNotepadFile(file: NotepadFile, content: string): Promise<void> {
		const notepadDir = await ensureNotepadDir()
		if (!notepadDir) throw new Error("No active plan. Create a plan first with /plan.")

		const filePath = path.join(notepadDir, file)
		const timestamp = new Date().toISOString().slice(0, 10)
		const entry = `\n## ${timestamp}\n${content.trim()}\n`

		try {
			await fs.appendFile(filePath, entry, "utf8")
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				// Create file with header
				const header = `# ${file.replace(".md", "").charAt(0).toUpperCase() + file.replace(".md", "").slice(1)}\n`
				await fs.writeFile(filePath, header + entry, "utf8")
			} else {
				throw error
			}
		}
	}

	return {
		tool: {
			plan_save: tool({
				description:
					"Save the implementation plan as markdown. Must include citations (ref:delegation-id) for decisions based on research. Plan is validated before saving.",
				args: {
					content: tool.schema.string().describe("The full plan in markdown format"),
				},
				async execute(args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_save requires sessionID. This is a system error."
					}

					const result = parsePlanMarkdown(args.content)
					if (!result.ok) {
						return formatParseError(result.error, result.hint)
					}

					const existingState = await readActivePlanState()
					let planPath: string
					let isNewPlan = false

					if (existingState) {
						planPath = existingState.active_plan

						if (!existingState.session_ids.includes(toolCtx.sessionID)) {
							existingState.session_ids.push(toolCtx.sessionID)
							await writeActivePlanState(existingState)
						}
					} else {
						await fs.mkdir(plansDir, { recursive: true })
						planPath = generatePlanPath(plansDir)
						isNewPlan = true

						const state: ActivePlanState = {
							active_plan: planPath,
							started_at: new Date().toISOString(),
							session_ids: [toolCtx.sessionID],
							plan_name: getPlanName(planPath),
						}
						await writeActivePlanState(state)
					}

					await fs.writeFile(planPath, args.content, "utf8")

					const warningCount = result.warnings?.length ?? 0
					const warningText =
						warningCount > 0 ? ` (${warningCount} warnings: ${result.warnings?.join(", ")})` : ""

					const relativePath = path.relative(directory, planPath)
					const action = isNewPlan ? "created" : "updated"

					return `Plan ${action} at ${relativePath}.${warningText}`
				},
			}),

			plan_read: tool({
				description: "Read the current implementation plan for this session.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
				},
				async execute(_args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_read requires sessionID. This is a system error."
					}

					// 1. Try project-scoped active plan first
					const activePlan = await readActivePlanState()
					if (activePlan) {
						await appendSessionToActivePlan(toolCtx.sessionID)

						try {
							return await fs.readFile(activePlan.active_plan, "utf8")
						} catch (error) {
							if (isNodeError(error) && error.code === "ENOENT") {
								return `❌ Active plan file not found at ${activePlan.active_plan}. The plan may have been deleted.`
							}
							throw error
						}
					}

					// 2. Fall back to legacy session-scoped plan
					const rootID = await getRootSessionID(toolCtx.sessionID)
					const legacyPlanPath = path.join(legacyBaseDir, rootID, "plan.md")
					try {
						const content = await fs.readFile(legacyPlanPath, "utf8")
						return `${content}\n\n---\n<migration-notice>\nThis plan is from the legacy session-scoped storage. Next time you save, it will be migrated to project-scoped storage at .opencode/workspace/plans/\n</migration-notice>`
					} catch (error) {
						if (isNodeError(error) && error.code === "ENOENT") {
							return "No plan found. Use /plan to create a new plan."
						}
						throw error
					}
				},
			}),

			plan_list: tool({
				description: "List all plans in this project. Shows active plan and completed plans.",
				args: {},
				async execute(_args, toolCtx) {
					if (!toolCtx?.sessionID) {
						return "❌ plan_list requires sessionID. This is a system error."
					}

					const activePlan = await readActivePlanState()

					let allPlans: string[] = []
					try {
						await fs.mkdir(plansDir, { recursive: true })
						const files = await fs.readdir(plansDir)
						allPlans = files
							.filter((f) => f.endsWith(".md"))
							.map((f) => path.join(plansDir, f))
							.sort()
							.reverse() // Newest first
					} catch (error) {
						if (!isNodeError(error) || error.code !== "ENOENT") throw error
					}

					if (allPlans.length === 0) {
						return "No plans found in .opencode/workspace/plans/. Use /plan to create one."
					}

					const planList: string[] = []

					if (activePlan) {
						planList.push(`## Active Plan\n`)
						planList.push(`**Name**: ${activePlan.plan_name}`)
						planList.push(`**Path**: ${path.relative(directory, activePlan.active_plan)}`)
						planList.push(`**Started**: ${activePlan.started_at}`)
						planList.push(
							`**Sessions**: ${activePlan.session_ids.length} session(s) have worked on this plan`,
						)
						planList.push(``)
					}

					const otherPlans = allPlans.filter((p) => p !== activePlan?.active_plan)
					if (otherPlans.length > 0) {
						planList.push(`## Other Plans (${otherPlans.length})`)
						for (const planPath of otherPlans) {
							const stats = await fs.stat(planPath)
							const name = getPlanName(planPath)
							const relativePath = path.relative(directory, planPath)
							planList.push(`- **${name}**: ${relativePath} (modified: ${stats.mtime.toISOString()})`)
						}
					}

					return planList.join("\n")
				},
			}),

			// ==========================================
			// NOTEPAD TOOLS
			// ==========================================

			notepad_read: tool({
				description:
					"Read accumulated wisdom from the notepad for the active plan. Returns learnings, issues, and decisions discovered during implementation. ALWAYS read before delegating tasks to pass inherited wisdom.",
				args: {
					file: tool.schema
						.enum(["all", "learnings", "issues", "decisions"])
						.optional()
						.describe("Which notepad file to read. Defaults to 'all'."),
				},
				async execute(args) {
					const notepadDir = await getNotepadDir()
					if (!notepadDir) {
						return "No active plan. Create a plan first with /plan, then use notepad to record learnings."
					}

					const fileToRead = args.file ?? "all"
					const results: string[] = []

					if (fileToRead === "all") {
						for (const file of NOTEPAD_FILES) {
							const content = await readNotepadFile(file)
							if (content) {
								results.push(`--- ${file} ---\n${content}`)
							}
						}
					} else {
						const content = await readNotepadFile(`${fileToRead}.md` as NotepadFile)
						if (content) {
							results.push(content)
						}
					}

					if (results.length === 0) {
						const activePlan = await readActivePlanState()
						return `Notepad is empty for plan "${activePlan?.plan_name}". Use notepad_write to record learnings, issues, or decisions.`
					}

					return results.join("\n\n")
				},
			}),

			notepad_write: tool({
				description:
					"Append learnings, issues, or decisions to the notepad for the active plan. Use this to persist wisdom across sessions and share with subagents.",
				args: {
					file: tool.schema
						.enum(["learnings", "issues", "decisions"])
						.describe(
							"Which notepad file to write to. learnings=patterns/conventions, issues=gotchas/problems, decisions=rationales",
						),
					content: tool.schema
						.string()
						.describe("The content to append. Will be timestamped automatically."),
				},
				async execute(args) {
					try {
						await appendToNotepadFile(`${args.file}.md` as NotepadFile, args.content)
						const notepadDir = await getNotepadDir()
						const relativePath = path.relative(directory, notepadDir!)
						return `✅ Appended to ${relativePath}/${args.file}.md`
					} catch (error) {
						if (error instanceof Error) {
							return `❌ ${error.message}`
						}
						throw error
					}
				},
			}),

			notepad_list: tool({
				description: "List all notepad files for the active plan with their sizes.",
				args: {},
				async execute() {
					const notepadDir = await getNotepadDir()
					if (!notepadDir) {
						return "No active plan. Create a plan first with /plan."
					}

					const activePlan = await readActivePlanState()
					const results: string[] = [`## Notepad for "${activePlan?.plan_name}"\n`]
					results.push(`Path: ${path.relative(directory, notepadDir)}/\n`)

					let hasFiles = false
					for (const file of NOTEPAD_FILES) {
						try {
							const filePath = path.join(notepadDir, file)
							const stats = await fs.stat(filePath)
							const content = await fs.readFile(filePath, "utf8")
							const lineCount = content.split("\n").length
							results.push(`- **${file}**: ${lineCount} lines, ${stats.size} bytes`)
							hasFiles = true
						} catch (error) {
							if (isNodeError(error) && error.code === "ENOENT") {
								results.push(`- **${file}**: (not created)`)
							} else {
								throw error
							}
						}
					}

					if (!hasFiles) {
						results.push("\nNo notepad files yet. Use notepad_write to start recording wisdom.")
					}

					return results.join("\n")
				},
			}),
		},
	}
}

export default WorkspacePlugin
