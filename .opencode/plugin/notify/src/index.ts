/**
 * Harness Notify Plugin
 *
 * Combined notification plugin that merges the best features from:
 * - oh-my-opencode: In-app toasts, race condition handling, idle confirmation
 * - opencode-workspace: Focus detection, quiet hours, click-to-focus, per-event sounds
 *
 * Features:
 * - In-app toasts (ctx.client.tui.showToast) for task progress
 * - Desktop notifications (osascript/notify-send/PowerShell)
 * - Terminal focus detection (suppresses notifications when already looking)
 * - Quiet hours configuration
 * - Click-to-focus on macOS
 * - Per-event sounds
 * - Idle confirmation delay (prevents false positives)
 * - Parent session only by default (no spam from sub-tasks)
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

// ==========================================
// TYPES
// ==========================================

interface NotifyConfig {
	/** Notify for child/sub-session events (default: false) */
	notifyChildSessions: boolean
	/** Sound configuration per event type */
	sounds: {
		idle: string
		error: string
		permission: string
	}
	/** Quiet hours configuration */
	quietHours: {
		enabled: boolean
		start: string // "HH:MM" format
		end: string // "HH:MM" format
	}
	/** Delay in ms before sending notification to confirm session is still idle (default: 1500) */
	idleConfirmationDelay: number
	/** Skip notification if there are incomplete todos (default: true) */
	skipIfIncompleteTodos: boolean
	/** Show in-app toasts in addition to desktop notifications (default: true) */
	showToasts: boolean
	/** Override terminal detection (optional) */
	terminal?: string
}

interface TerminalInfo {
	name: string | null
	bundleId: string | null
	processName: string | null
}

interface Todo {
	content: string
	status: string
	priority: string
	id: string
}

type Platform = "darwin" | "linux" | "win32" | "unsupported"

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: NotifyConfig = {
	notifyChildSessions: false,
	sounds: {
		idle: "Glass",
		error: "Basso",
		permission: "Submarine",
	},
	quietHours: {
		enabled: false,
		start: "22:00",
		end: "08:00",
	},
	idleConfirmationDelay: 1500,
	skipIfIncompleteTodos: true,
	showToasts: true,
}

// Terminal name to macOS process name mapping (for focus detection)
const TERMINAL_PROCESS_NAMES: Record<string, string> = {
	ghostty: "Ghostty",
	kitty: "kitty",
	iterm: "iTerm2",
	iterm2: "iTerm2",
	wezterm: "WezTerm",
	alacritty: "Alacritty",
	terminal: "Terminal",
	apple_terminal: "Terminal",
	hyper: "Hyper",
	warp: "Warp",
	vscode: "Code",
	"vscode-insiders": "Code - Insiders",
}

// Default sound paths per platform
const DEFAULT_SOUND_PATHS: Record<Platform, string> = {
	darwin: "/System/Library/Sounds/Glass.aiff",
	linux: "/usr/share/sounds/freedesktop/stereo/complete.oga",
	win32: "C:\\Windows\\Media\\notify.wav",
	unsupported: "",
}

// ==========================================
// PLATFORM DETECTION
// ==========================================

function detectPlatform(): Platform {
	const p = process.platform
	if (p === "darwin" || p === "linux" || p === "win32") return p
	return "unsupported"
}

// ==========================================
// CONFIGURATION
// ==========================================

async function loadConfig(projectDir: string): Promise<NotifyConfig> {
	// Try project-local config first, then global config
	const configPaths = [
		path.join(projectDir, "notify.json"),
		path.join(projectDir, ".opencode", "notify.json"),
		path.join(os.homedir(), ".config", "opencode", "notify.json"),
	]

	for (const configPath of configPaths) {
		try {
			const content = await fs.readFile(configPath, "utf8")
			const userConfig = JSON.parse(content) as Partial<NotifyConfig>

			return {
				...DEFAULT_CONFIG,
				...userConfig,
				sounds: {
					...DEFAULT_CONFIG.sounds,
					...userConfig.sounds,
				},
				quietHours: {
					...DEFAULT_CONFIG.quietHours,
					...userConfig.quietHours,
				},
			}
		} catch {
			// Try next path
			continue
		}
	}

	// No config found, use defaults
	return DEFAULT_CONFIG
}

// ==========================================
// TERMINAL DETECTION (macOS)
// ==========================================

async function runOsascript(script: string): Promise<string | null> {
	if (process.platform !== "darwin") return null

	try {
		const proc = Bun.spawn(["osascript", "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
		})
		const output = await new Response(proc.stdout).text()
		return output.trim()
	} catch {
		return null
	}
}

async function getBundleId(appName: string): Promise<string | null> {
	return runOsascript(`id of application "${appName}"`)
}

async function getFrontmostApp(): Promise<string | null> {
	return runOsascript(
		'tell application "System Events" to get name of first application process whose frontmost is true',
	)
}

function detectTerminal(): string | null {
	// Check common terminal environment variables
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase()
	if (termProgram) return termProgram

	// Check for specific terminals
	if (process.env.GHOSTTY_RESOURCES_DIR) return "ghostty"
	if (process.env.KITTY_WINDOW_ID) return "kitty"
	if (process.env.ITERM_SESSION_ID) return "iterm2"
	if (process.env.WEZTERM_PANE) return "wezterm"
	if (process.env.ALACRITTY_SOCKET) return "alacritty"
	if (process.env.WARP_IS_LOCAL_SHELL_SESSION) return "warp"
	if (process.env.VSCODE_INJECTION) return "vscode"

	return null
}

async function detectTerminalInfo(config: NotifyConfig): Promise<TerminalInfo> {
	const terminalName = config.terminal || detectTerminal()

	if (!terminalName) {
		return { name: null, bundleId: null, processName: null }
	}

	const processName = TERMINAL_PROCESS_NAMES[terminalName.toLowerCase()] || terminalName
	const bundleId = await getBundleId(processName)

	return {
		name: terminalName,
		bundleId,
		processName,
	}
}

async function isTerminalFocused(terminalInfo: TerminalInfo): Promise<boolean> {
	if (!terminalInfo.processName) return false
	if (process.platform !== "darwin") return false

	const frontmost = await getFrontmostApp()
	if (!frontmost) return false

	return frontmost.toLowerCase() === terminalInfo.processName.toLowerCase()
}

// ==========================================
// QUIET HOURS CHECK
// ==========================================

function isQuietHours(config: NotifyConfig): boolean {
	if (!config.quietHours.enabled) return false

	const now = new Date()
	const currentMinutes = now.getHours() * 60 + now.getMinutes()

	const [startHour, startMin] = config.quietHours.start.split(":").map(Number)
	const [endHour, endMin] = config.quietHours.end.split(":").map(Number)

	const startMinutes = startHour * 60 + startMin
	const endMinutes = endHour * 60 + endMin

	// Handle overnight quiet hours (e.g., 22:00 - 08:00)
	if (startMinutes > endMinutes) {
		return currentMinutes >= startMinutes || currentMinutes < endMinutes
	}

	return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// ==========================================
// TODO CHECK
// ==========================================

async function hasIncompleteTodos(ctx: PluginInput, sessionID: string): Promise<boolean> {
	try {
		const response = await ctx.client.session.todo({ path: { id: sessionID } })
		const todos = (response.data ?? response) as Todo[]
		if (!todos || todos.length === 0) return false
		return todos.some((t) => t.status !== "completed" && t.status !== "cancelled")
	} catch {
		return false
	}
}

// ==========================================
// PARENT SESSION DETECTION
// ==========================================

async function isParentSession(ctx: PluginInput, sessionID: string): Promise<boolean> {
	try {
		const session = await ctx.client.session.get({ path: { id: sessionID } })
		return !(session.data as any)?.parentID
	} catch {
		return true
	}
}

// ==========================================
// NOTIFICATION SENDERS
// ==========================================

async function sendDesktopNotification(
	ctx: PluginInput,
	platform: Platform,
	title: string,
	message: string,
	terminalInfo: TerminalInfo,
	soundName?: string,
	onPermissionNeeded?: () => void,
): Promise<void> {
	switch (platform) {
		case "darwin": {
			// Use osascript for notifications
			// Note: Clicking osascript notifications always opens Script Editor - this is a macOS limitation
			// To have click-to-focus terminal, install terminal-notifier: brew install terminal-notifier
			const esTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
			const esMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

			// Build notification command with optional sound
			let osascriptCmd = `display notification "${esMessage}" with title "${esTitle}"`
			if (soundName) {
				osascriptCmd += ` sound name "${soundName}"`
			}

			try {
				await ctx.$`osascript -e ${osascriptCmd}`
			} catch {
				// osascript failed - try terminal-notifier as fallback (if installed)
				try {
					const args = ["-title", title, "-message", message, "-group", "opencode"]
					if (terminalInfo.bundleId) {
						args.push("-activate", terminalInfo.bundleId)
					}
					if (soundName) {
						args.push("-sound", soundName)
					}
					await ctx.$`terminal-notifier ${args} > /dev/null 2>&1`
				} catch {
					// Both failed - show permission hint if callback provided
					if (onPermissionNeeded) {
						onPermissionNeeded()
					}
				}
			}
			break
		}
		case "linux": {
			await ctx.$`notify-send ${title} ${message} 2>/dev/null`.catch(() => {})
			break
		}
		case "win32": {
			const psTitle = title.replace(/'/g, "''")
			const psMessage = message.replace(/'/g, "''")
			const toastScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$Template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$RawXml = [xml] $Template.GetXml()
($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq '1'}).AppendChild($RawXml.CreateTextNode('${psTitle}')) | Out-Null
($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq '2'}).AppendChild($RawXml.CreateTextNode('${psMessage}')) | Out-Null
$SerializedXml = New-Object Windows.Data.Xml.Dom.XmlDocument
$SerializedXml.LoadXml($RawXml.OuterXml)
$Toast = [Windows.UI.Notifications.ToastNotification]::new($SerializedXml)
$Notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenCode')
$Notifier.Show($Toast)
`
				.trim()
				.replace(/\n/g, "; ")
			await ctx.$`powershell -Command ${toastScript}`.catch(() => {})
			break
		}
	}
}

async function playSound(ctx: PluginInput, platform: Platform, soundName: string): Promise<void> {
	// Map sound name to actual file path
	const soundPath = DEFAULT_SOUND_PATHS[platform]

	switch (platform) {
		case "darwin": {
			// On macOS, we can use the sound name directly with afplay
			const macSoundPath = `/System/Library/Sounds/${soundName}.aiff`
			ctx.$`afplay ${macSoundPath}`.catch(() => {})
			break
		}
		case "linux": {
			ctx.$`paplay ${soundPath} 2>/dev/null`.catch(() => {
				ctx.$`aplay ${soundPath} 2>/dev/null`.catch(() => {})
			})
			break
		}
		case "win32": {
			ctx.$`powershell -Command ${"(New-Object Media.SoundPlayer '" + soundPath.replace(/'/g, "''") + "').PlaySync()"}`
				.catch(() => {})
			break
		}
	}
}

async function showInAppToast(
	ctx: PluginInput,
	title: string,
	message: string,
	variant: "info" | "success" | "warning" | "error" = "info",
): Promise<void> {
	const client = ctx.client as any
	if (!client.tui?.showToast) return

	await client.tui
		.showToast({
			body: {
				title,
				message,
				variant,
				duration: 4000,
			},
		})
		.catch(() => {})
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

const HarnessNotifyPlugin: Plugin = async (ctx) => {
	const platform = detectPlatform()
	if (platform === "unsupported") {
		return {}
	}

	// Load config once at startup (checks project dir first, then global)
	const config = await loadConfig(ctx.directory)

	// Detect terminal once at startup (cached for performance)
	const terminalInfo = await detectTerminalInfo(config)

	// Track notification state (from oh-my-opencode)
	const notifiedSessions = new Set<string>()
	const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
	const sessionActivitySinceIdle = new Set<string>()
	const notificationVersions = new Map<string, number>()
	const executingNotifications = new Set<string>()

	// Track if we've shown permission hint (only show once per session)
	let permissionHintShown = false

	function cancelPendingNotification(sessionID: string) {
		const timer = pendingTimers.get(sessionID)
		if (timer) {
			clearTimeout(timer)
			pendingTimers.delete(sessionID)
		}
		sessionActivitySinceIdle.add(sessionID)
		notificationVersions.set(sessionID, (notificationVersions.get(sessionID) ?? 0) + 1)
	}

	function markSessionActivity(sessionID: string) {
		cancelPendingNotification(sessionID)
		notifiedSessions.delete(sessionID)
	}

	async function executeNotification(
		sessionID: string,
		version: number,
		title: string,
		message: string,
		soundName: string,
	) {
		// Guard against duplicate execution
		if (executingNotifications.has(sessionID)) return
		if (notificationVersions.get(sessionID) !== version) return
		if (sessionActivitySinceIdle.has(sessionID)) {
			sessionActivitySinceIdle.delete(sessionID)
			return
		}
		if (notifiedSessions.has(sessionID)) return

		executingNotifications.add(sessionID)
		try {
			// Check incomplete todos
			if (config.skipIfIncompleteTodos) {
				const hasPendingWork = await hasIncompleteTodos(ctx, sessionID)
				if (notificationVersions.get(sessionID) !== version) return
				if (hasPendingWork) return
			}

			// Re-check version after async operation
			if (notificationVersions.get(sessionID) !== version) return
			if (sessionActivitySinceIdle.has(sessionID)) {
				sessionActivitySinceIdle.delete(sessionID)
				return
			}

			// Check quiet hours
			if (isQuietHours(config)) return

			// Check if terminal is focused
			if (await isTerminalFocused(terminalInfo)) return

			notifiedSessions.add(sessionID)

			// Permission hint callback (only show once per session)
			const showPermissionHint = () => {
				if (permissionHintShown) return
				permissionHintShown = true
				showInAppToast(
					ctx,
					"Desktop Notifications Setup",
					"To enable: Open Script Editor.app → Run: display notification \"test\" → Click Allow",
					"warning",
				)
			}

			// Send desktop notification (includes sound on macOS via osascript)
			await sendDesktopNotification(ctx, platform, title, message, terminalInfo, soundName, showPermissionHint)

			// Play sound separately for non-macOS platforms
			if (platform !== "darwin") {
				await playSound(ctx, platform, soundName)
			}

			// Show in-app toast if enabled
			if (config.showToasts) {
				await showInAppToast(ctx, title, message, "info")
			}
		} finally {
			executingNotifications.delete(sessionID)
			pendingTimers.delete(sessionID)
		}
	}

	return {
		event: async ({ event }: { event: { type: string; properties?: any } }) => {
			const props = event.properties

			// Track activity to cancel pending notifications
			if (event.type === "session.updated" || event.type === "session.created") {
				const sessionID = props?.info?.id as string | undefined
				if (sessionID) markSessionActivity(sessionID)
				return
			}

			if (event.type === "message.updated" || event.type === "message.created") {
				const sessionID = props?.info?.sessionID as string | undefined
				if (sessionID) markSessionActivity(sessionID)
				return
			}

			if (event.type === "tool.execute.before" || event.type === "tool.execute.after") {
				const sessionID = props?.sessionID as string | undefined
				if (sessionID) markSessionActivity(sessionID)
				return
			}

			// Handle session idle - main notification trigger
			if (event.type === "session.idle") {
				const sessionID = props?.sessionID as string | undefined
				if (!sessionID) return

				// Skip if not parent session (unless configured otherwise)
				if (!config.notifyChildSessions) {
					const isParent = await isParentSession(ctx, sessionID)
					if (!isParent) return
				}

				// Skip if already notified or pending
				if (notifiedSessions.has(sessionID)) return
				if (pendingTimers.has(sessionID)) return
				if (executingNotifications.has(sessionID)) return

				sessionActivitySinceIdle.delete(sessionID)

				const currentVersion = (notificationVersions.get(sessionID) ?? 0) + 1
				notificationVersions.set(sessionID, currentVersion)

				// Get session title for context
				let sessionTitle = "Task complete"
				try {
					const session = await ctx.client.session.get({ path: { id: sessionID } })
					if ((session.data as any)?.title) {
						sessionTitle = (session.data as any).title.slice(0, 50)
					}
				} catch {
					// Use default
				}

				// Schedule notification with confirmation delay
				const timer = setTimeout(() => {
					executeNotification(
						sessionID,
						currentVersion,
						"Ready for review",
						sessionTitle,
						config.sounds.idle,
					)
				}, config.idleConfirmationDelay)

				pendingTimers.set(sessionID, timer)
				return
			}

			// Handle errors
			if (event.type === "session.error") {
				const sessionID = props?.sessionID as string | undefined
				if (!sessionID) return

				if (!config.notifyChildSessions) {
					const isParent = await isParentSession(ctx, sessionID)
					if (!isParent) return
				}

				if (isQuietHours(config)) return
				if (await isTerminalFocused(terminalInfo)) return

				const errorMessage =
					typeof props?.error === "string"
						? props.error.slice(0, 100)
						: "Something went wrong"

				await sendDesktopNotification(
					ctx,
					platform,
					"Something went wrong",
					errorMessage,
					terminalInfo,
					config.sounds.error,
				)
				if (platform !== "darwin") {
					await playSound(ctx, platform, config.sounds.error)
				}

				if (config.showToasts) {
					await showInAppToast(ctx, "Error", errorMessage, "error")
				}
				return
			}

			// Handle permission requests
			if (event.type === "permission.updated") {
				if (isQuietHours(config)) return
				if (await isTerminalFocused(terminalInfo)) return

				await sendDesktopNotification(
					ctx,
					platform,
					"Waiting for you",
					"OpenCode needs your input",
					terminalInfo,
					config.sounds.permission,
				)
				if (platform !== "darwin") {
					await playSound(ctx, platform, config.sounds.permission)
				}

				if (config.showToasts) {
					await showInAppToast(ctx, "Input Required", "OpenCode needs your input", "warning")
				}
				return
			}

			// Cleanup on session delete
			if (event.type === "session.deleted") {
				const sessionID = props?.info?.id as string | undefined
				if (sessionID) {
					cancelPendingNotification(sessionID)
					notifiedSessions.delete(sessionID)
					sessionActivitySinceIdle.delete(sessionID)
					notificationVersions.delete(sessionID)
					executingNotifications.delete(sessionID)
				}
			}
		},
	}
}

export default HarnessNotifyPlugin
