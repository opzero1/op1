/**
 * Structured Logger for @op1/code-intel
 *
 * Provides consistent, structured logging with levels and context.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: number;
	context?: Record<string, unknown>;
	error?: Error;
}

export interface Logger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, error?: Error, context?: Record<string, unknown>): void;

	/** Create a child logger with additional context */
	child(context: Record<string, unknown>): Logger;

	/** Set minimum log level */
	setLevel(level: LogLevel): void;

	/** Get all log entries (for testing/debugging) */
	getEntries(): LogEntry[];

	/** Clear stored entries */
	clear(): void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface LoggerOptions {
	/** Minimum level to log (default: "info") */
	level?: LogLevel;
	/** Whether to store entries in memory (default: false) */
	storeEntries?: boolean;
	/** Maximum entries to store (default: 1000) */
	maxEntries?: number;
	/** Whether to output to console (default: true) */
	console?: boolean;
	/** Prefix for all log messages */
	prefix?: string;
	/** Base context added to all entries */
	baseContext?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
	const {
		level: initialLevel = "info",
		storeEntries = false,
		maxEntries = 1000,
		console: useConsole = true,
		prefix = "[code-intel]",
		baseContext = {},
	} = options;

	let currentLevel = initialLevel;
	const entries: LogEntry[] = [];

	function shouldLog(level: LogLevel): boolean {
		return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
	}

	function formatMessage(
		level: LogLevel,
		message: string,
		context?: Record<string, unknown>,
	): string {
		const timestamp = new Date().toISOString();
		const contextStr =
			context && Object.keys(context).length > 0
				? ` ${JSON.stringify(context)}`
				: "";
		return `${timestamp} ${prefix} [${level.toUpperCase()}] ${message}${contextStr}`;
	}

	function log(
		level: LogLevel,
		message: string,
		context?: Record<string, unknown>,
		error?: Error,
	): void {
		if (!shouldLog(level)) return;

		const mergedContext = { ...baseContext, ...context };
		const entry: LogEntry = {
			level,
			message,
			timestamp: Date.now(),
			context: Object.keys(mergedContext).length > 0 ? mergedContext : undefined,
			error,
		};

		if (storeEntries) {
			entries.push(entry);
			if (entries.length > maxEntries) {
				entries.shift();
			}
		}

		if (useConsole) {
			const formatted = formatMessage(level, message, mergedContext);
			switch (level) {
				case "debug":
					console.debug(formatted);
					break;
				case "info":
					console.info(formatted);
					break;
				case "warn":
					console.warn(formatted);
					break;
				case "error":
					console.error(formatted);
					if (error) {
						console.error(error.stack);
					}
					break;
			}
		}
	}

	const logger: Logger = {
		debug(message: string, context?: Record<string, unknown>): void {
			log("debug", message, context);
		},

		info(message: string, context?: Record<string, unknown>): void {
			log("info", message, context);
		},

		warn(message: string, context?: Record<string, unknown>): void {
			log("warn", message, context);
		},

		error(
			message: string,
			error?: Error,
			context?: Record<string, unknown>,
		): void {
			log("error", message, context, error);
		},

		child(context: Record<string, unknown>): Logger {
			return createLogger({
				level: currentLevel,
				storeEntries,
				maxEntries,
				console: useConsole,
				prefix,
				baseContext: { ...baseContext, ...context },
			});
		},

		setLevel(level: LogLevel): void {
			currentLevel = level;
		},

		getEntries(): LogEntry[] {
			return [...entries];
		},

		clear(): void {
			entries.length = 0;
		},
	};

	return logger;
}

/** Silent logger for testing */
export const nullLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => nullLogger,
	setLevel: () => {},
	getEntries: () => [],
	clear: () => {},
};
