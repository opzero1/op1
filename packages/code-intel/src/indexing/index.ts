/**
 * Indexing Layer exports
 */

export { createFastSyncCache } from "./fast-sync-cache";
export type { FastSyncCache, FastSyncCacheConfig } from "./fast-sync-cache";

export { createBranchManager } from "./branch-manager";
export type { BranchManager } from "./branch-manager";

export { createIndexManager } from "./index-manager";
export type { IndexManager, IndexManagerConfig } from "./index-manager";

export { createJobQueue, createIndexingJobQueue } from "./job-queue";
export type {
	JobQueue,
	IndexingJobQueue,
	Job,
	JobPriority,
	JobStatus,
	JobQueueConfig,
	QueueStats,
} from "./job-queue";

export { createFileWatcher } from "./file-watcher";
export type {
	FileWatcher,
	FileWatcherConfig,
	FileChange,
	FileChangeBatch,
	FileChangeType,
} from "./file-watcher";

export {
	createLifecycleManager,
	isReady,
	isIndexing,
	isUsable,
	isErrored,
	isUninitialized,
} from "./lifecycle";
export type {
	LifecycleManager,
	LifecycleStatus,
	LifecycleTransition,
} from "./lifecycle";
