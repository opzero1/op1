import type { TaskRecord } from "./state.js";

export interface DelegationClient {
	session: {
		get: (input: { path: { id: string } }) => Promise<{ data?: unknown }>;
		create: (input: {
			body?: {
				title?: string;
				parentID?: string;
			};
			query?: {
				directory?: string;
			};
		}) => Promise<{ data?: unknown; error?: unknown }>;
		prompt: (input: {
			path: { id: string };
			body: {
				agent?: string;
				parts: Array<{ type: "text"; text: string }>;
				tools?: Record<string, boolean>;
			};
		}) => Promise<{ data?: unknown; error?: unknown }>;
		promptAsync: (input: {
			path: { id: string };
			body: {
				agent?: string;
				parts: Array<{ type: "text"; text: string }>;
				tools?: Record<string, boolean>;
			};
		}) => Promise<{ data?: unknown; error?: unknown }>;
		messages: (input: {
			path: { id: string };
			query?: { limit?: number };
		}) => Promise<{ data?: unknown; error?: unknown }>;
		abort: (input: { path: { id: string } }) => Promise<unknown>;
		status?: (input: {
			path: { id: string };
		}) => Promise<{ data?: Record<string, { type?: string }> }>;
	};
	app?: {
		agents?: () => Promise<{ data?: Array<{ name?: string; mode?: string }> }>;
	};
}

export interface DelegationToolContext {
	sessionID?: string;
	messageID?: string;
	callID?: string;
	callId?: string;
	call_id?: string;
	agent?: string;
	abort?: AbortSignal;
	ask?: (input: {
		permission: string;
		patterns: string[];
		always?: string[];
		metadata?: Record<string, string | number | boolean>;
	}) => Promise<void>;
	metadata?: (input: {
		title?: string;
		metadata?: Record<string, unknown>;
	}) => void | Promise<void>;
}

export interface DelegationToolResult {
	title: string;
	metadata: Record<string, unknown>;
	output: string;
}

export interface DelegationToolExecuteAfterInput {
	tool: string;
	sessionID: string;
	callID: string;
	args?: unknown;
}

export interface TaskToolArgs {
	description: string;
	prompt: string;
	subagent_type?: string;
	task_id?: string;
	command?: string;
	run_in_background?: boolean;
	category?: string;
	auto_route?: boolean;
}

export interface BackgroundOutputArgs {
	task_id: string;
	block?: boolean;
	timeout?: number;
	full_session?: boolean;
	include_thinking?: boolean;
	include_tool_results?: boolean;
	message_limit?: number;
}

export interface BackgroundCancelArgs {
	task_id?: string;
	all?: boolean;
	reason?: string;
}

export interface FormattedTaskIdentity {
	task_id: string;
	reference: string;
	session_id: string;
}

export interface SessionMessage {
	id?: string;
	role: string;
	created_at?: string;
	parts: Array<Record<string, unknown>>;
}

export interface FullSessionFormatOptions {
	includeThinking?: boolean;
	includeToolResults?: boolean;
	messageLimit?: number;
	task: TaskRecord;
}
