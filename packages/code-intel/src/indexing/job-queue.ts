/**
 * Job Queue for Serialized Writes
 *
 * Priority queue with backpressure handling for indexing operations.
 * Configurable concurrency with priority support for LSP calls.
 */

// ============================================================================
// Types
// ============================================================================

export type JobPriority = "critical" | "high" | "normal" | "low";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Job<T = unknown> {
	id: string;
	priority: JobPriority;
	status: JobStatus;
	execute: () => Promise<T>;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	result?: T;
	error?: Error;
	/** Metadata for debugging */
	metadata?: Record<string, unknown>;
}

export interface JobQueueConfig {
	/** Maximum concurrent jobs (default: 4) */
	concurrency: number;
	/** Maximum queue size before backpressure (default: 1000) */
	maxQueueSize: number;
	/** Job timeout in milliseconds (default: 30000) */
	jobTimeout: number;
	/** Whether to retry failed jobs (default: false) */
	retryOnFailure: boolean;
	/** Maximum retry attempts (default: 2) */
	maxRetries: number;
}

export interface QueueStats {
	pending: number;
	running: number;
	completed: number;
	failed: number;
	cancelled: number;
	totalProcessed: number;
	averageProcessingTime: number;
}

export interface JobQueue<T = unknown> {
	/** Add a job to the queue */
	enqueue(
		execute: () => Promise<T>,
		priority?: JobPriority,
		metadata?: Record<string, unknown>,
	): string;

	/** Add a job and wait for result */
	enqueueAndWait(
		execute: () => Promise<T>,
		priority?: JobPriority,
		metadata?: Record<string, unknown>,
	): Promise<T>;

	/** Cancel a pending job */
	cancel(jobId: string): boolean;

	/** Cancel all pending jobs */
	cancelAll(): number;

	/** Get job by ID */
	getJob(jobId: string): Job<T> | null;

	/** Get queue statistics */
	getStats(): QueueStats;

	/** Check if queue is accepting jobs (not at capacity) */
	canAccept(): boolean;

	/** Wait for all jobs to complete */
	drain(): Promise<void>;

	/** Pause processing */
	pause(): void;

	/** Resume processing */
	resume(): void;

	/** Check if paused */
	isPaused(): boolean;

	/** Shutdown the queue */
	shutdown(): Promise<void>;
}

// ============================================================================
// Priority Weights
// ============================================================================

const PRIORITY_WEIGHT: Record<JobPriority, number> = {
	critical: 0,
	high: 1,
	normal: 2,
	low: 3,
};

// ============================================================================
// Implementation
// ============================================================================

export function createJobQueue<T = unknown>(
	config: Partial<JobQueueConfig> = {},
): JobQueue<T> {
	const {
		concurrency = 4,
		maxQueueSize = 1000,
		jobTimeout = 30000,
		retryOnFailure = false,
		maxRetries = 2,
	} = config;

	const pendingJobs: Job<T>[] = [];
	const runningJobs = new Map<string, Job<T>>();
	const completedJobs = new Map<string, Job<T>>();
	const jobPromises = new Map<string, { resolve: (value: T) => void; reject: (error: Error) => void }>();
	const retryCount = new Map<string, number>();

	let jobIdCounter = 0;
	let paused = false;
	let shuttingDown = false;
	let totalProcessed = 0;
	let totalProcessingTime = 0;

	function generateJobId(): string {
		return `job_${Date.now()}_${++jobIdCounter}`;
	}

	function sortQueue(): void {
		pendingJobs.sort((a, b) => {
			const priorityDiff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
			if (priorityDiff !== 0) return priorityDiff;
			return a.createdAt - b.createdAt;
		});
	}

	async function processJob(job: Job<T>): Promise<void> {
		job.status = "running";
		job.startedAt = Date.now();
		runningJobs.set(job.id, job);

		try {
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(
					() => reject(new Error(`Job ${job.id} timed out after ${jobTimeout}ms`)),
					jobTimeout,
				);
			});

			const result = await Promise.race([job.execute(), timeoutPromise]);
			
			job.status = "completed";
			job.result = result;
			job.completedAt = Date.now();

			const processingTime = job.completedAt - job.startedAt;
			totalProcessingTime += processingTime;
			totalProcessed++;

			// Resolve waiting promise
			const promise = jobPromises.get(job.id);
			if (promise) {
				promise.resolve(result);
				jobPromises.delete(job.id);
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			
			// Check for retry
			const attempts = retryCount.get(job.id) ?? 0;
			if (retryOnFailure && attempts < maxRetries) {
				retryCount.set(job.id, attempts + 1);
				job.status = "pending";
				job.startedAt = undefined;
				pendingJobs.push(job);
				sortQueue();
			} else {
				job.status = "failed";
				job.error = err;
				job.completedAt = Date.now();
				totalProcessed++;

				// Reject waiting promise
				const promise = jobPromises.get(job.id);
				if (promise) {
					promise.reject(err);
					jobPromises.delete(job.id);
				}
			}
		} finally {
			runningJobs.delete(job.id);
			completedJobs.set(job.id, job);

			// Keep completed jobs map bounded
			if (completedJobs.size > maxQueueSize) {
				const firstKey = completedJobs.keys().next().value;
				if (firstKey) completedJobs.delete(firstKey);
			}

			// Process next
			processNext();
		}
	}

	function processNext(): void {
		if (paused || shuttingDown) return;
		if (runningJobs.size >= concurrency) return;
		if (pendingJobs.length === 0) return;

		const job = pendingJobs.shift();
		if (!job) return;

		processJob(job);
	}

	return {
		enqueue(
			execute: () => Promise<T>,
			priority: JobPriority = "normal",
			metadata?: Record<string, unknown>,
		): string {
			if (shuttingDown) {
				throw new Error("Queue is shutting down, cannot accept new jobs");
			}

			if (pendingJobs.length >= maxQueueSize) {
				throw new Error(
					`Queue at capacity (${maxQueueSize}), apply backpressure`,
				);
			}

			const job: Job<T> = {
				id: generateJobId(),
				priority,
				status: "pending",
				execute,
				createdAt: Date.now(),
				metadata,
			};

			pendingJobs.push(job);
			sortQueue();
			processNext();

			return job.id;
		},

		async enqueueAndWait(
			execute: () => Promise<T>,
			priority: JobPriority = "normal",
			metadata?: Record<string, unknown>,
		): Promise<T> {
			const jobId = this.enqueue(execute, priority, metadata);

			return new Promise<T>((resolve, reject) => {
				jobPromises.set(jobId, { resolve, reject });
			});
		},

		cancel(jobId: string): boolean {
			const index = pendingJobs.findIndex((j) => j.id === jobId);
			if (index === -1) return false;

			const job = pendingJobs[index];
			job.status = "cancelled";
			job.completedAt = Date.now();
			pendingJobs.splice(index, 1);
			completedJobs.set(jobId, job);

			// Reject waiting promise
			const promise = jobPromises.get(jobId);
			if (promise) {
				promise.reject(new Error("Job cancelled"));
				jobPromises.delete(jobId);
			}

			return true;
		},

		cancelAll(): number {
			const count = pendingJobs.length;
			
			for (const job of pendingJobs) {
				job.status = "cancelled";
				job.completedAt = Date.now();
				completedJobs.set(job.id, job);

				const promise = jobPromises.get(job.id);
				if (promise) {
					promise.reject(new Error("Job cancelled"));
					jobPromises.delete(job.id);
				}
			}

			pendingJobs.length = 0;
			return count;
		},

		getJob(jobId: string): Job<T> | null {
			// Check pending
			const pending = pendingJobs.find((j) => j.id === jobId);
			if (pending) return pending;

			// Check running
			const running = runningJobs.get(jobId);
			if (running) return running;

			// Check completed
			const completed = completedJobs.get(jobId);
			if (completed) return completed;

			return null;
		},

		getStats(): QueueStats {
			let failed = 0;
			let cancelled = 0;
			let completed = 0;

			for (const job of completedJobs.values()) {
				if (job.status === "failed") failed++;
				else if (job.status === "cancelled") cancelled++;
				else if (job.status === "completed") completed++;
			}

			return {
				pending: pendingJobs.length,
				running: runningJobs.size,
				completed,
				failed,
				cancelled,
				totalProcessed,
				averageProcessingTime:
					totalProcessed > 0 ? totalProcessingTime / totalProcessed : 0,
			};
		},

		canAccept(): boolean {
			return !shuttingDown && pendingJobs.length < maxQueueSize;
		},

		async drain(): Promise<void> {
			while (pendingJobs.length > 0 || runningJobs.size > 0) {
				await new Promise((r) => setTimeout(r, 50));
			}
		},

		pause(): void {
			paused = true;
		},

		resume(): void {
			paused = false;
			// Process any pending jobs
			while (runningJobs.size < concurrency && pendingJobs.length > 0) {
				processNext();
			}
		},

		isPaused(): boolean {
			return paused;
		},

		async shutdown(): Promise<void> {
			shuttingDown = true;
			
			// Cancel all pending jobs
			this.cancelAll();

			// Wait for running jobs to complete
			while (runningJobs.size > 0) {
				await new Promise((r) => setTimeout(r, 50));
			}
		},
	};
}

// ============================================================================
// Specialized Queue Factory
// ============================================================================

export interface IndexingJobQueue extends JobQueue<void> {
	/** Enqueue an LSP operation with high priority */
	enqueueLspOperation(
		filePath: string,
		execute: () => Promise<void>,
	): string;

	/** Enqueue a symbol extraction with normal priority */
	enqueueSymbolExtraction(
		filePath: string,
		execute: () => Promise<void>,
	): string;

	/** Enqueue an edge extraction with normal priority */
	enqueueEdgeExtraction(
		filePath: string,
		execute: () => Promise<void>,
	): string;

	/** Enqueue a batch write with low priority */
	enqueueBatchWrite(execute: () => Promise<void>): string;
}

export function createIndexingJobQueue(
	config: Partial<JobQueueConfig> = {},
): IndexingJobQueue {
	const baseQueue = createJobQueue<void>({
		concurrency: 4,
		maxQueueSize: 2000,
		jobTimeout: 60000,
		retryOnFailure: true,
		maxRetries: 2,
		...config,
	});

	return {
		...baseQueue,

		enqueueLspOperation(filePath: string, execute: () => Promise<void>): string {
			return baseQueue.enqueue(execute, "high", {
				type: "lsp",
				filePath,
			});
		},

		enqueueSymbolExtraction(
			filePath: string,
			execute: () => Promise<void>,
		): string {
			return baseQueue.enqueue(execute, "normal", {
				type: "symbol-extraction",
				filePath,
			});
		},

		enqueueEdgeExtraction(
			filePath: string,
			execute: () => Promise<void>,
		): string {
			return baseQueue.enqueue(execute, "normal", {
				type: "edge-extraction",
				filePath,
			});
		},

		enqueueBatchWrite(execute: () => Promise<void>): string {
			return baseQueue.enqueue(execute, "low", {
				type: "batch-write",
			});
		},
	};
}
