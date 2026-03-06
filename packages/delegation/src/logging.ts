export enum LogLevel {
	DEBUG = "DEBUG",
	INFO = "INFO",
	WARN = "WARN",
	ERROR = "ERROR",
	SILENT = "SILENT",
}

type LogExtras = Record<string, unknown>;

type LogSinkInput = {
	service: string;
	level: string;
	message: string;
	extra?: LogExtras;
};

type LogSink = (input: LogSinkInput) => Promise<void> | void;

type Logger = {
	debug: (message: string, extras?: LogExtras) => void;
	info: (message: string, extras?: LogExtras) => void;
	warn: (message: string, extras?: LogExtras) => void;
	error: (message: string, extras?: LogExtras) => void;
};

const levelPriority: Record<LogLevel, number> = {
	[LogLevel.DEBUG]: 0,
	[LogLevel.INFO]: 1,
	[LogLevel.WARN]: 2,
	[LogLevel.ERROR]: 3,
	[LogLevel.SILENT]: 4,
};

function parseLogLevel(input: string | undefined): LogLevel {
	if (!input) return LogLevel.WARN;

	const level = input.toUpperCase();
	if (level === LogLevel.DEBUG) return LogLevel.DEBUG;
	if (level === LogLevel.INFO) return LogLevel.INFO;
	if (level === LogLevel.WARN) return LogLevel.WARN;
	if (level === LogLevel.ERROR) return LogLevel.ERROR;
	if (level === LogLevel.SILENT || level === "OFF" || level === "NONE") {
		return LogLevel.SILENT;
	}

	return LogLevel.WARN;
}

function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
	return levelPriority[level] >= levelPriority[threshold];
}

function formatValue(value: unknown): string {
	if (value instanceof Error) return value.message;

	if (typeof value === "object" && value !== null) {
		try {
			return JSON.stringify(value);
		} catch {
			return "[unserializable-object]";
		}
	}

	return String(value);
}

function serializeExtras(extras?: LogExtras): string {
	if (!extras) return "";

	const pairs = Object.entries(extras)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${formatValue(value)}`);

	if (pairs.length === 0) return "";
	return ` ${pairs.join(" ")}`;
}

export function createLogger(service: string, sink?: LogSink): Logger {
	const threshold = parseLogLevel(Bun.env.OP7_WORKSPACE_LOG_LEVEL);

	function write(level: LogLevel, message: string, extras?: LogExtras): void {
		if (!shouldLog(level, threshold)) return;
		if (sink) {
			void Promise.resolve(
				sink({
					service,
					level: level.toLowerCase(),
					message,
					...(extras ? { extra: extras } : {}),
				}),
			).catch(() => undefined);
			return;
		}

		if (Bun.env.OP1_PLUGIN_STDERR_LOGS !== "true") {
			return;
		}

		const timestamp = new Date().toISOString();
		const line = `${timestamp} ${level} service=${service} ${message}${serializeExtras(extras)}\n`;
		void Bun.write(Bun.stderr, line);
	}

	return {
		debug: (message, extras) => write(LogLevel.DEBUG, message, extras),
		info: (message, extras) => write(LogLevel.INFO, message, extras),
		warn: (message, extras) => write(LogLevel.WARN, message, extras),
		error: (message, extras) => write(LogLevel.ERROR, message, extras),
	};
}
