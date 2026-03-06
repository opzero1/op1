/**
 * Indexing Layer exports
 */

export type { BranchManager } from "./branch-manager";
export { createBranchManager } from "./branch-manager";
export type { FastSyncCache, FastSyncCacheConfig } from "./fast-sync-cache";
export { createFastSyncCache } from "./fast-sync-cache";
export type {
	FileChange,
	FileChangeBatch,
	FileChangeType,
	FileWatcher,
	FileWatcherConfig,
} from "./file-watcher";
export { createFileWatcher } from "./file-watcher";
export type { IndexManager, IndexManagerConfig } from "./index-manager";
export { createIndexManager } from "./index-manager";
export type {
	IndexingJobQueue,
	Job,
	JobPriority,
	JobQueue,
	JobQueueConfig,
	JobStatus,
	QueueStats,
} from "./job-queue";
export { createIndexingJobQueue, createJobQueue } from "./job-queue";
export type {
	LifecycleManager,
	LifecycleStatus,
	LifecycleTransition,
} from "./lifecycle";
export {
	createLifecycleManager,
	isErrored,
	isIndexing,
	isReady,
	isUninitialized,
	isUsable,
} from "./lifecycle";
