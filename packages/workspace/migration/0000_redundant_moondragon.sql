CREATE TABLE `project_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`repo_root_path` text NOT NULL,
	`workspace_root_path` text NOT NULL,
	`repo_remote_url` text,
	`repo_default_branch` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT "chk_project_scopes_time_created" CHECK("project_scopes"."time_created" > 0),
	CONSTRAINT "chk_project_scopes_time_updated" CHECK("project_scopes"."time_updated" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_scopes_scope_key` ON `project_scopes` (`scope_key`);--> statement-breakpoint
CREATE INDEX `idx_project_scopes_repo_root_path` ON `project_scopes` (`repo_root_path`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_scope_id` text NOT NULL,
	`plan_name` text NOT NULL,
	`title` text,
	`description` text,
	`status` text NOT NULL,
	`phase` integer NOT NULL,
	`content_markdown` text NOT NULL,
	`is_active` integer DEFAULT 0 NOT NULL,
	`source_kind` text DEFAULT 'native' NOT NULL,
	`import_source_path` text,
	`import_idempotency_key` text,
	`time_started` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`project_scope_id`) REFERENCES `project_scopes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_plans_status" CHECK("plans"."status" IN ('not-started', 'in-progress', 'complete', 'blocked')),
	CONSTRAINT "chk_plans_phase" CHECK("plans"."phase" >= 1),
	CONSTRAINT "chk_plans_is_active" CHECK("plans"."is_active" IN (0, 1)),
	CONSTRAINT "chk_plans_source_kind" CHECK("plans"."source_kind" IN ('native', 'migrated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_plans_scope_plan_name` ON `plans` (`project_scope_id`,`plan_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_plans_one_active_per_scope` ON `plans` (`project_scope_id`) WHERE "plans"."is_active" = 1;--> statement-breakpoint
CREATE INDEX `idx_plans_project_scope_id` ON `plans` (`project_scope_id`);--> statement-breakpoint
CREATE INDEX `idx_plans_scope_status_updated` ON `plans` (`project_scope_id`,`status`,`time_updated`);--> statement-breakpoint
CREATE INDEX `idx_plans_scope_time_started` ON `plans` (`project_scope_id`,`time_started`);--> statement-breakpoint
CREATE TABLE `plan_sessions` (
	`plan_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_linked` integer NOT NULL,
	PRIMARY KEY(`plan_id`, `session_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_plan_sessions_time_linked" CHECK("plan_sessions"."time_linked" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_plan_sessions_session_id` ON `plan_sessions` (`session_id`);--> statement-breakpoint
CREATE TABLE `notepad_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_scope_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_kind` text DEFAULT 'native' NOT NULL,
	`source_position` integer,
	`time_created` integer NOT NULL,
	FOREIGN KEY (`project_scope_id`) REFERENCES `project_scopes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_notepad_entries_category" CHECK("notepad_entries"."category" IN ('learnings', 'issues', 'decisions')),
	CONSTRAINT "chk_notepad_entries_source_kind" CHECK("notepad_entries"."source_kind" IN ('native', 'migrated')),
	CONSTRAINT "chk_notepad_entries_time_created" CHECK("notepad_entries"."time_created" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notepad_entries_dedupe` ON `notepad_entries` (`plan_id`,`category`,`content_hash`,`source_position`);--> statement-breakpoint
CREATE INDEX `idx_notepad_entries_plan_category_time` ON `notepad_entries` (`plan_id`,`category`,`time_created`);--> statement-breakpoint
CREATE INDEX `idx_notepad_entries_scope_time` ON `notepad_entries` (`project_scope_id`,`time_created`);--> statement-breakpoint
CREATE TABLE `worktree_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_scope_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch_name` text NOT NULL,
	`base_branch` text,
	`session_id` text,
	`status` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`project_scope_id`) REFERENCES `project_scopes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_worktree_refs_status" CHECK("worktree_refs"."status" IN ('active', 'merged', 'closed', 'stale'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_worktree_refs_scope_path` ON `worktree_refs` (`project_scope_id`,`worktree_path`);--> statement-breakpoint
CREATE INDEX `idx_worktree_refs_scope_status` ON `worktree_refs` (`project_scope_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_worktree_refs_scope_branch` ON `worktree_refs` (`project_scope_id`,`branch_name`);