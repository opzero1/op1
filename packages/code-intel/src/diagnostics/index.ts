/**
 * Diagnostics module exports
 */

export {
	createLogger,
	type LogEntry,
	type Logger,
	type LoggerOptions,
	type LogLevel,
	nullLogger,
} from "./logger";

export {
	type CodeIntelMetrics,
	type Counter,
	createCodeIntelMetrics,
	createMetricsRegistry,
	type Gauge,
	type Histogram,
	type HistogramStats,
	type MetricsRegistry,
	type MetricsSnapshot,
	type Timer,
} from "./metrics";
