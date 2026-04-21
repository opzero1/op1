/**
 * Notification Channels Hook
 *
 * Emits low-noise, deduplicated notification events through `client.app.log`,
 * `client.tui.showToast`, and desktop notifications via `node-notifier`.
 */

type NotificationLevel = "debug" | "info" | "warn" | "error";
type PrivacyMode = "strict" | "balanced";

type DesktopNotifyCallback = (
	error: Error | null | undefined,
	response?: unknown,
	metadata?: unknown,
) => void;

interface DesktopNotificationRequest {
	title: string;
	message: string;
	timeout?: number;
	wait?: boolean;
}

export interface DesktopNotifier {
	notify: (
		options: DesktopNotificationRequest,
		callback?: DesktopNotifyCallback,
	) => void;
}

interface NodeNotifierModule {
	default?: unknown;
	notify?: unknown;
}

interface QuietHoursWindow {
	startMinutes: number;
	endMinutes: number;
	timezone: string;
}

export interface NotificationClient {
	app?: {
		log?: (input: {
			body: {
				service: string;
				level: NotificationLevel;
				message: string;
				extra?: Record<string, unknown>;
			};
		}) => Promise<unknown>;
	};
	tui?: {
		showToast?: (input: {
			body?: {
				title?: string;
				message?: string;
				variant?: "info" | "success" | "warning" | "error";
				duration?: number;
			};
		}) => Promise<unknown>;
	};
}

interface NotificationInput {
	tool: string;
	sessionID: string;
	callID: string;
	args?: unknown;
}

interface NotificationOutput {
	title: string;
	output: string;
	metadata: unknown;
}

interface NotificationHookOptions {
	now?: () => Date;
	getSystemTimezone?: () => string;
	enabled?: boolean;
	desktop?: boolean;
	desktopNotifier?: DesktopNotifier;
	quietHours?: string;
	timezone?: string;
	privacy?: PrivacyMode;
}

export interface SessionReadyNotificationInput {
	sessionID: string;
	source?: string;
	routingContext?: NotificationRoutingContext;
}

export interface NotificationRoutingContext {
	rootSessionID: string;
	childSessionID?: string;
	taskID?: string;
}

export interface InputNeededNotificationInput {
	sessionID: string;
	callID?: string;
	tool?: string;
	source?: string;
	kind?: "question" | "permission" | "plan";
	questionText?: string;
	routingContext?: NotificationRoutingContext;
}

interface NotificationExtraInput {
	sessionID: string;
	callID?: string;
	tool?: string;
	source?: string;
	routingContext?: NotificationRoutingContext;
}

interface NotificationEvent {
	dedupeKey: string;
	title: string;
	message: string;
	logMessage?: string;
	desktopTitle?: string;
	desktopMessage?: string;
	level: NotificationLevel;
	extraInput: NotificationExtraInput;
	ttlMs?: number;
}

const DEDUP_TTL_MS = 5 * 60 * 1000;
const INPUT_NEEDED_DEDUP_TTL_MS = 1_000;
const SESSION_READY_DEDUP_TTL_MS = 1_000;
const PERMISSION_HINT_PATTERN =
	/\b(permission|approve|approval|allow|deny|consent)\b/i;
const sentEvents = new Map<string, { timestamp: number; ttlMs: number }>();

const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseClockMinutes(value: string): number | null {
	const match = value.match(HH_MM_PATTERN);
	if (!match) return null;

	const hours = Number.parseInt(match[1] || "", 10);
	const minutes = Number.parseInt(match[2] || "", 10);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
		return null;
	}

	return hours * 60 + minutes;
}

function isValidTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

function resolveTimezone(
	rawTimezone: string | undefined,
	getSystemTimezone: () => string,
): string {
	const fallback = getSystemTimezone() || "UTC";
	if (!rawTimezone) {
		return isValidTimezone(fallback) ? fallback : "UTC";
	}

	return isValidTimezone(rawTimezone)
		? rawTimezone
		: isValidTimezone(fallback)
			? fallback
			: "UTC";
}

function parseQuietHoursWindow(
	raw: string | undefined,
	rawTimezone: string | undefined,
	getSystemTimezone: () => string,
): QuietHoursWindow | null {
	if (!raw) return null;

	const [startRaw, endRaw] = raw.split("-").map((part) => part.trim());
	if (!startRaw || !endRaw) return null;

	const startMinutes = parseClockMinutes(startRaw);
	const endMinutes = parseClockMinutes(endRaw);
	if (startMinutes === null || endMinutes === null) return null;

	if (startMinutes === endMinutes) return null;

	const timezone = resolveTimezone(rawTimezone, getSystemTimezone);

	return {
		startMinutes,
		endMinutes,
		timezone,
	};
}

function getCurrentMinutesInTimezone(now: Date, timezone: string): number {
	const formatter = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const parts = formatter.formatToParts(now);
	const hourPart = parts.find((part) => part.type === "hour")?.value;
	const minutePart = parts.find((part) => part.type === "minute")?.value;

	const hours = Number.parseInt(hourPart || "", 10);
	const minutes = Number.parseInt(minutePart || "", 10);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;

	return hours * 60 + minutes;
}

function isInQuietHours(
	currentMinutes: number,
	window: QuietHoursWindow,
): boolean {
	if (window.startMinutes > window.endMinutes) {
		return (
			currentMinutes >= window.startMinutes ||
			currentMinutes < window.endMinutes
		);
	}

	return (
		currentMinutes >= window.startMinutes && currentMinutes < window.endMinutes
	);
}

function notificationsPrivacyMode(raw: string | undefined): PrivacyMode {
	if (!raw) return "strict";

	const normalized = raw.trim().toLowerCase();
	if (normalized === "balanced") return "balanced";
	return "strict";
}

function buildNotificationExtra(
	input: NotificationExtraInput,
	mode: PrivacyMode,
): Record<string, unknown> {
	const rootSessionID = input.routingContext?.rootSessionID;
	const childSessionID = input.routingContext?.childSessionID;
	const taskID = input.routingContext?.taskID;

	if (mode === "balanced") {
		return {
			privacy_mode: "balanced",
			session_id: input.sessionID,
			call_id: input.callID,
			tool: input.tool,
			source: input.source,
			root_session_id: rootSessionID,
			child_session_id: childSessionID,
			task_id: taskID,
		};
	}

	const extra: Record<string, unknown> = {
		privacy_mode: "strict",
		session_id: input.sessionID,
	};
	if (input.callID) {
		extra.call_id = input.callID;
	}
	return extra;
}

function notificationsEnabled(raw: string | undefined): boolean {
	if (!raw) return false;

	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on";
}

function isDesktopNotifier(value: unknown): value is DesktopNotifier {
	if (!value || typeof value !== "object") return false;
	const record = value as { notify?: unknown };
	return typeof record.notify === "function";
}

function supportsDesktopNotifications(): boolean {
	if (process.platform !== "linux") return true;

	return Boolean(Bun.env.DISPLAY || Bun.env.WAYLAND_DISPLAY);
}

async function loadDesktopNotifier(): Promise<DesktopNotifier | null> {
	try {
		const module = (await import("node-notifier")) as NodeNotifierModule;
		const candidate = module.default ?? module;
		if (!isDesktopNotifier(candidate)) return null;
		return candidate;
	} catch {
		return null;
	}
}

function sendDesktopNotification(
	notifier: DesktopNotifier,
	event: { title: string; message: string },
): Promise<void> {
	return new Promise((resolve) => {
		try {
			notifier.notify(
				{
					title: event.title,
					message: event.message,
					wait: false,
					timeout: 5,
				},
				() => resolve(),
			);
			resolve();
		} catch {
			resolve();
		}
	});
}

function createEventKey(input: NotificationInput): string {
	return `${input.sessionID}:${input.callID}:${input.tool.toLowerCase()}`;
}

function pruneDedup(now: number): void {
	for (const [key, entry] of sentEvents.entries()) {
		if (now - entry.timestamp > entry.ttlMs) {
			sentEvents.delete(key);
		}
	}
}

function getNotificationMessage(
	input: NotificationInput,
	output: NotificationOutput,
): {
	message: string;
	title: string;
	level: NotificationLevel;
} | null {
	const tool = input.tool.toLowerCase();

	if (tool === "task") {
		return {
			title: "Task Complete",
			message: `Task tool completed: ${output.title}`,
			level: "info",
		};
	}

	if (tool === "doctor") {
		const lower = output.output.toLowerCase();
		if (lower.includes("status: error")) {
			return {
				title: "Doctor Status",
				message: "Doctor report detected ERROR status",
				level: "error",
			};
		}

		if (lower.includes("status: warn")) {
			return {
				title: "Doctor Status",
				message: "Doctor report detected WARN status",
				level: "warn",
			};
		}

		return {
			title: "Doctor Status",
			message: "Doctor report completed with OK status",
			level: "info",
		};
	}

	return null;
}

function getSessionReadyNotification(
	input: SessionReadyNotificationInput,
): NotificationEvent {
	const source = input.source?.trim() || "session.idle";
	const routingKey = buildRoutingDedupeKey(input.routingContext);
	const contextSuffix = buildRoutingContextSuffix(input.routingContext);
	const desktopRoutingSuffix = buildDesktopRoutingSuffix(input.routingContext);
	const baseMessage = "Assistant turn complete. Ready for your next prompt.";
	const isDelegated = hasDelegatedRoutingContext(input.routingContext);
	return {
		dedupeKey: `${input.sessionID}:${source}${routingKey}`,
		title: "Ready for Input",
		message: `${baseMessage}${contextSuffix}`,
		logMessage: baseMessage,
		desktopTitle: isDelegated ? "Delegated Session Ready" : "Ready for Input",
		desktopMessage: `${baseMessage}${desktopRoutingSuffix}`,
		level: "info",
		ttlMs: SESSION_READY_DEDUP_TTL_MS,
		extraInput: {
			sessionID: input.sessionID,
			source,
			routingContext: input.routingContext,
		},
	};
}

function getInputNeededNotification(
	input: InputNeededNotificationInput,
): NotificationEvent {
	const source = input.source?.trim() || input.kind || "input-needed";
	const routingKey = buildRoutingDedupeKey(input.routingContext);
	const contextSuffix = buildRoutingContextSuffix(input.routingContext);
	const desktopRoutingSuffix = buildDesktopRoutingSuffix(input.routingContext);
	const kind = resolveInputNeededKind(input);
	const title =
		kind === "permission"
			? "Permission Needed"
			: kind === "plan"
				? "Plan Input Needed"
				: "Question for You";
	const message =
		kind === "permission"
			? "Assistant needs permission to continue."
			: kind === "plan"
				? "Plan workflow needs your decision to continue."
				: "Assistant is asking a question.";
	const desktopMessage =
		kind === "permission"
			? "Assistant is waiting for permission. Approve or deny to continue."
			: kind === "plan"
				? "Plan workflow is blocked and needs your decision."
				: "Assistant is waiting for your answer to continue.";
	const isDelegated = hasDelegatedRoutingContext(input.routingContext);
	const dedupeToken = buildInputNeededDedupeToken(input);

	return {
		dedupeKey: `${input.sessionID}:${source}:${dedupeToken}${routingKey}`,
		title,
		message: `${message}${contextSuffix}`,
		logMessage: message,
		desktopTitle: isDelegated ? `${title} (Delegated)` : title,
		desktopMessage: `${desktopMessage}${desktopRoutingSuffix}`,
		level: "info",
		ttlMs: INPUT_NEEDED_DEDUP_TTL_MS,
		extraInput: {
			sessionID: input.sessionID,
			callID: input.callID,
			tool: input.tool,
			source,
			routingContext: input.routingContext,
		},
	};
}

function buildInputNeededDedupeToken(
	input: InputNeededNotificationInput,
): string {
	if (input.callID?.trim()) {
		return input.callID.trim();
	}

	const normalizedQuestion = input.questionText?.trim();
	if (normalizedQuestion) {
		return `text:${fingerprintText(normalizedQuestion)}`;
	}

	return input.kind ?? "input";
}

function resolveInputNeededKind(
	input: InputNeededNotificationInput,
): "question" | "permission" | "plan" {
	if (input.kind) {
		return input.kind;
	}

	return PERMISSION_HINT_PATTERN.test(input.questionText?.trim() || "")
		? "permission"
		: "question";
}

interface NormalizedRoutingContext {
	rootSessionID: string;
	childSessionID?: string;
	taskID?: string;
}

function normalizeRoutingContext(
	routingContext: NotificationRoutingContext | undefined,
): NormalizedRoutingContext | null {
	if (!routingContext) {
		return null;
	}

	const rootSessionID = routingContext.rootSessionID.trim();
	if (!rootSessionID) {
		return null;
	}

	const childSessionID = routingContext.childSessionID?.trim();
	const taskID = routingContext.taskID?.trim();

	return {
		rootSessionID,
		childSessionID: childSessionID && childSessionID.length > 0 ? childSessionID : undefined,
		taskID: taskID && taskID.length > 0 ? taskID : undefined,
	};
}

function hasDelegatedRoutingContext(
	routingContext: NotificationRoutingContext | undefined,
): boolean {
	const normalized = normalizeRoutingContext(routingContext);
	if (!normalized) {
		return false;
	}

	const hasChild =
		typeof normalized.childSessionID === "string" &&
		normalized.childSessionID !== normalized.rootSessionID;
	return hasChild || typeof normalized.taskID === "string";
}

function buildRoutingDedupeKey(
	routingContext: NotificationRoutingContext | undefined,
): string {
	const normalized = normalizeRoutingContext(routingContext);
	if (!normalized) {
		return "";
	}

	const parts = [
		normalized.rootSessionID,
		normalized.childSessionID,
		normalized.taskID,
	].filter((part): part is string => typeof part === "string" && part.length > 0);

	if (parts.length <= 1) {
		return "";
	}

	return `:${parts.join(":")}`;
}

function buildRoutingContextSuffix(
	routingContext: NotificationRoutingContext | undefined,
): string {
	const normalized = normalizeRoutingContext(routingContext);
	if (!normalized) {
		return "";
	}

	const breadcrumbParts: string[] = [`root ${normalized.rootSessionID}`];
	if (
		typeof normalized.childSessionID === "string" &&
		normalized.childSessionID !== normalized.rootSessionID
	) {
		breadcrumbParts.push(`child ${normalized.childSessionID}`);
	}
	if (typeof normalized.taskID === "string") {
		breadcrumbParts.push(`task ${normalized.taskID}`);
	}

	if (breadcrumbParts.length <= 1) {
		return "";
	}

	return ` [${breadcrumbParts.join(" • ")}]`;
}

function buildDesktopRoutingSuffix(
	routingContext: NotificationRoutingContext | undefined,
): string {
	const normalized = normalizeRoutingContext(routingContext);
	if (!normalized) {
		return "";
	}

	const hasChild =
		typeof normalized.childSessionID === "string" &&
		normalized.childSessionID !== normalized.rootSessionID;
	if (!hasChild && !normalized.taskID) {
		return "";
	}

	if (hasChild && normalized.taskID) {
		return ` Delegated from child ${normalized.childSessionID} (task ${normalized.taskID}) to root ${normalized.rootSessionID}.`;
	}

	if (hasChild) {
		return ` Delegated from child ${normalized.childSessionID} to root ${normalized.rootSessionID}.`;
	}

	return ` Delegated task ${normalized.taskID} is routed to root ${normalized.rootSessionID}.`;
}

function fingerprintText(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}

	return (hash >>> 0).toString(16);
}

function mapLevelToToastVariant(
	level: NotificationLevel,
): "info" | "success" | "warning" | "error" {
	if (level === "error") return "error";
	if (level === "warn") return "warning";
	if (level === "debug") return "info";
	return "success";
}

export function createNotificationChannelsHook(
	client: NotificationClient,
	options?: NotificationHookOptions,
): (input: NotificationInput, output: NotificationOutput) => Promise<void> {
	const dispatch = createNotificationDispatcher(client, options);

	return async (input, output) => {
		const event = getNotificationMessage(input, output);
		if (!event) return;
		await dispatch({
			dedupeKey: createEventKey(input),
			title: event.title,
			message: event.message,
			level: event.level,
			extraInput: {
				sessionID: input.sessionID,
				callID: input.callID,
				tool: input.tool,
			},
		});
	};
}

function createNotificationDispatcher(
	client: NotificationClient,
	options?: NotificationHookOptions,
): (event: NotificationEvent) => Promise<void> {
	const getNow = options?.now ?? (() => new Date());
	const getSystemTimezone =
		options?.getSystemTimezone ??
		(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
	const enabled =
		typeof options?.enabled === "boolean"
			? options.enabled
			: notificationsEnabled(Bun.env.OP7_WORKSPACE_NOTIFICATIONS);
	const desktopEnabled =
		typeof options?.desktop === "boolean"
			? options.desktop
			: notificationsEnabled(Bun.env.OP7_WORKSPACE_NOTIFICATIONS_DESKTOP);
	const desktopNotifierPromise =
		desktopEnabled && supportsDesktopNotifications()
			? isDesktopNotifier(options?.desktopNotifier)
				? Promise.resolve(options.desktopNotifier)
				: loadDesktopNotifier()
			: Promise.resolve<DesktopNotifier | null>(null);
	const quietHoursInput =
		typeof options?.quietHours === "string"
			? options.quietHours
			: Bun.env.OP7_WORKSPACE_NOTIFICATIONS_QUIET_HOURS;
	const timezoneInput =
		typeof options?.timezone === "string"
			? options.timezone
			: Bun.env.OP7_WORKSPACE_NOTIFICATIONS_TIMEZONE;
	const privacyInput =
		typeof options?.privacy === "string"
			? options.privacy
			: Bun.env.OP7_WORKSPACE_NOTIFICATIONS_PRIVACY;

	return async (event: NotificationEvent): Promise<void> => {
		if (!enabled) return;
		if (!client.app?.log && !client.tui?.showToast && !desktopEnabled) return;

		const quietHours = parseQuietHoursWindow(
			quietHoursInput,
			timezoneInput,
			getSystemTimezone,
		);
		const now = getNow();
		if (quietHours) {
			const currentMinutes = getCurrentMinutesInTimezone(
				now,
				quietHours.timezone,
			);
			if (isInQuietHours(currentMinutes, quietHours)) {
				return;
			}
		}

		const nowMs = now.getTime();
		pruneDedup(nowMs);
		if (sentEvents.has(event.dedupeKey)) return;
		sentEvents.set(event.dedupeKey, {
			timestamp: nowMs,
			ttlMs: event.ttlMs ?? DEDUP_TTL_MS,
		});

		const privacyMode = notificationsPrivacyMode(privacyInput);
		const logMessage =
			privacyMode === "strict"
				? event.logMessage ?? event.message
				: event.message;
		const writeLog = client.app?.log
			? client.app.log({
					body: {
						service: "workspace.notifications",
						level: event.level,
						message: logMessage,
						extra: buildNotificationExtra(event.extraInput, privacyMode),
					},
				})
			: Promise.resolve();
		const showToast = client.tui?.showToast
			? client.tui.showToast({
					body: {
						title: event.title,
						message: event.message,
						variant: mapLevelToToastVariant(event.level),
						duration: 5000,
					},
				})
			: Promise.resolve();
		const desktopNotifier = await desktopNotifierPromise;
		const showDesktop = desktopNotifier
			? sendDesktopNotification(desktopNotifier, {
					title: event.desktopTitle ?? event.title,
					message: event.desktopMessage ?? event.message,
				})
			: Promise.resolve();

		await Promise.allSettled([writeLog, showToast, showDesktop]);
	};
}

export function createSessionReadyNotificationHook(
	client: NotificationClient,
	options?: NotificationHookOptions,
): (input: SessionReadyNotificationInput) => Promise<void> {
	const dispatch = createNotificationDispatcher(client, options);

	return async (input: SessionReadyNotificationInput): Promise<void> => {
		const signal = getSessionReadyNotification(input);
		return dispatch(signal);
	};
}

export function createInputNeededNotificationHook(
	client: NotificationClient,
	options?: NotificationHookOptions,
): (input: InputNeededNotificationInput) => Promise<void> {
	const dispatch = createNotificationDispatcher(client, options);

	return async (input: InputNeededNotificationInput): Promise<void> => {
		const signal = getInputNeededNotification(input);
		return dispatch(signal);
	};
}

export function resetNotificationChannelsState(): void {
	sentEvents.clear();
}
