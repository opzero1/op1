/**
 * Metrics Collection for @op1/code-intel
 *
 * Provides counters, gauges, histograms, and timing utilities
 * for observability and performance monitoring.
 */

export interface Counter {
	/** Increment by 1 */
	inc(): void;
	/** Increment by value */
	add(value: number): void;
	/** Get current value */
	get(): number;
	/** Reset to 0 */
	reset(): void;
}

export interface Gauge {
	/** Set value */
	set(value: number): void;
	/** Increment by 1 */
	inc(): void;
	/** Decrement by 1 */
	dec(): void;
	/** Get current value */
	get(): number;
}

export interface Histogram {
	/** Record a value */
	observe(value: number): void;
	/** Get statistics */
	getStats(): HistogramStats;
	/** Reset all values */
	reset(): void;
}

export interface HistogramStats {
	count: number;
	sum: number;
	min: number;
	max: number;
	avg: number;
	p50: number;
	p90: number;
	p99: number;
}

export interface Timer {
	/** Start timing and return a function to stop */
	start(): () => number;
	/** Time an async function */
	time<T>(fn: () => Promise<T>): Promise<T>;
	/** Time a sync function */
	timeSync<T>(fn: () => T): T;
	/** Get underlying histogram */
	getHistogram(): Histogram;
}

export interface MetricsRegistry {
	/** Create or get a counter */
	counter(name: string, help?: string): Counter;
	/** Create or get a gauge */
	gauge(name: string, help?: string): Gauge;
	/** Create or get a histogram */
	histogram(name: string, help?: string): Histogram;
	/** Create or get a timer (histogram for durations) */
	timer(name: string, help?: string): Timer;
	/** Get all metrics as a snapshot */
	snapshot(): MetricsSnapshot;
	/** Reset all metrics */
	reset(): void;
}

export interface MetricMeta {
	name: string;
	help?: string;
	type: "counter" | "gauge" | "histogram";
}

export interface MetricsSnapshot {
	timestamp: number;
	counters: Record<string, number>;
	gauges: Record<string, number>;
	histograms: Record<string, HistogramStats>;
}

function createCounter(): Counter {
	let value = 0;
	return {
		inc() {
			value++;
		},
		add(v: number) {
			value += v;
		},
		get() {
			return value;
		},
		reset() {
			value = 0;
		},
	};
}

function createGauge(): Gauge {
	let value = 0;
	return {
		set(v: number) {
			value = v;
		},
		inc() {
			value++;
		},
		dec() {
			value--;
		},
		get() {
			return value;
		},
	};
}

function createHistogram(): Histogram {
	const values: number[] = [];

	function percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}

	return {
		observe(value: number) {
			values.push(value);
		},

		getStats(): HistogramStats {
			if (values.length === 0) {
				return {
					count: 0,
					sum: 0,
					min: 0,
					max: 0,
					avg: 0,
					p50: 0,
					p90: 0,
					p99: 0,
				};
			}

			const sorted = [...values].sort((a, b) => a - b);
			const sum = values.reduce((a, b) => a + b, 0);

			return {
				count: values.length,
				sum,
				min: sorted[0],
				max: sorted[sorted.length - 1],
				avg: sum / values.length,
				p50: percentile(sorted, 50),
				p90: percentile(sorted, 90),
				p99: percentile(sorted, 99),
			};
		},

		reset() {
			values.length = 0;
		},
	};
}

function createTimer(histogram: Histogram): Timer {
	return {
		start(): () => number {
			const startTime = performance.now();
			return () => {
				const duration = performance.now() - startTime;
				histogram.observe(duration);
				return duration;
			};
		},

		async time<T>(fn: () => Promise<T>): Promise<T> {
			const stop = this.start();
			try {
				return await fn();
			} finally {
				stop();
			}
		},

		timeSync<T>(fn: () => T): T {
			const stop = this.start();
			try {
				return fn();
			} finally {
				stop();
			}
		},

		getHistogram(): Histogram {
			return histogram;
		},
	};
}

export function createMetricsRegistry(): MetricsRegistry {
	const counters = new Map<string, Counter>();
	const gauges = new Map<string, Gauge>();
	const histograms = new Map<string, Histogram>();
	const meta = new Map<string, MetricMeta>();

	return {
		counter(name: string, help?: string): Counter {
			let counter = counters.get(name);
			if (!counter) {
				counter = createCounter();
				counters.set(name, counter);
				meta.set(name, { name, help, type: "counter" });
			}
			return counter;
		},

		gauge(name: string, help?: string): Gauge {
			let gauge = gauges.get(name);
			if (!gauge) {
				gauge = createGauge();
				gauges.set(name, gauge);
				meta.set(name, { name, help, type: "gauge" });
			}
			return gauge;
		},

		histogram(name: string, help?: string): Histogram {
			let histogram = histograms.get(name);
			if (!histogram) {
				histogram = createHistogram();
				histograms.set(name, histogram);
				meta.set(name, { name, help, type: "histogram" });
			}
			return histogram;
		},

		timer(name: string, help?: string): Timer {
			const histogram = this.histogram(name, help);
			return createTimer(histogram);
		},

		snapshot(): MetricsSnapshot {
			const snapshot: MetricsSnapshot = {
				timestamp: Date.now(),
				counters: {},
				gauges: {},
				histograms: {},
			};

			for (const [name, counter] of counters) {
				snapshot.counters[name] = counter.get();
			}

			for (const [name, gauge] of gauges) {
				snapshot.gauges[name] = gauge.get();
			}

			for (const [name, histogram] of histograms) {
				snapshot.histograms[name] = histogram.getStats();
			}

			return snapshot;
		},

		reset(): void {
			for (const counter of counters.values()) {
				counter.reset();
			}
			for (const histogram of histograms.values()) {
				histogram.reset();
			}
			// Gauges are not reset as they represent current state
		},
	};
}

/**
 * Pre-defined metrics for code-intel operations
 */
export interface CodeIntelMetrics {
	// Indexing
	filesIndexed: Counter;
	symbolsExtracted: Counter;
	edgesExtracted: Counter;
	indexingErrors: Counter;
	indexingDuration: Timer;

	// Queries
	queriesExecuted: Counter;
	queryDuration: Timer;
	vectorSearches: Counter;
	keywordSearches: Counter;
	graphExpansions: Counter;

	// Cache
	cacheHits: Counter;
	cacheMisses: Counter;

	// Current state
	totalSymbols: Gauge;
	totalEdges: Gauge;
	totalFiles: Gauge;

	// Get registry for custom metrics
	registry: MetricsRegistry;
}

export function createCodeIntelMetrics(): CodeIntelMetrics {
	const registry = createMetricsRegistry();

	return {
		// Indexing
		filesIndexed: registry.counter("files_indexed", "Total files indexed"),
		symbolsExtracted: registry.counter(
			"symbols_extracted",
			"Total symbols extracted",
		),
		edgesExtracted: registry.counter("edges_extracted", "Total edges extracted"),
		indexingErrors: registry.counter(
			"indexing_errors",
			"Total indexing errors",
		),
		indexingDuration: registry.timer(
			"indexing_duration_ms",
			"Time to index files",
		),

		// Queries
		queriesExecuted: registry.counter(
			"queries_executed",
			"Total queries executed",
		),
		queryDuration: registry.timer("query_duration_ms", "Time to execute queries"),
		vectorSearches: registry.counter(
			"vector_searches",
			"Total vector searches",
		),
		keywordSearches: registry.counter(
			"keyword_searches",
			"Total keyword searches",
		),
		graphExpansions: registry.counter(
			"graph_expansions",
			"Total graph expansions",
		),

		// Cache
		cacheHits: registry.counter("cache_hits", "Cache hits"),
		cacheMisses: registry.counter("cache_misses", "Cache misses"),

		// Current state
		totalSymbols: registry.gauge("total_symbols", "Current total symbols"),
		totalEdges: registry.gauge("total_edges", "Current total edges"),
		totalFiles: registry.gauge("total_files", "Current total files"),

		registry,
	};
}
