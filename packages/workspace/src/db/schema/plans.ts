/**
 * plans table
 *
 * Stores plan content and active state for a project scope.
 * Includes partial unique index enforcing at most one active plan per scope.
 * See ADR-0002 for the full contract.
 */

import {
	sqliteTable,
	text,
	integer,
	uniqueIndex,
	index,
	check,
	foreignKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projectScopes } from "./project-scopes";

export const plans = sqliteTable(
	"plans",
	{
		id: text("id").primaryKey(),
		project_scope_id: text("project_scope_id").notNull(),
		plan_name: text("plan_name").notNull(),
		title: text("title"),
		description: text("description"),
		status: text("status").notNull(),
		phase: integer("phase").notNull(),
		content_markdown: text("content_markdown").notNull(),
		is_active: integer("is_active").notNull().default(0),
		source_kind: text("source_kind").notNull().default("native"),
		import_source_path: text("import_source_path"),
		import_idempotency_key: text("import_idempotency_key"),
		time_started: integer("time_started"),
		time_created: integer("time_created").notNull(),
		time_updated: integer("time_updated").notNull(),
	},
	(table) => [
		// Foreign keys
		foreignKey({
			name: "fk_plans_project_scope_id",
			columns: [table.project_scope_id],
			foreignColumns: [projectScopes.id],
		}).onDelete("cascade"),

		// Unique constraints
		uniqueIndex("uq_plans_scope_plan_name").on(
			table.project_scope_id,
			table.plan_name,
		),

		// Partial unique index: at most one active plan per scope
		uniqueIndex("uq_plans_one_active_per_scope")
			.on(table.project_scope_id)
			.where(sql`${table.is_active} = 1`),

		// Indexes
		index("idx_plans_project_scope_id").on(table.project_scope_id),
		index("idx_plans_scope_status_updated").on(
			table.project_scope_id,
			table.status,
			table.time_updated,
		),
		index("idx_plans_scope_time_started").on(
			table.project_scope_id,
			table.time_started,
		),

		// Check constraints
		check(
			"chk_plans_status",
			sql`${table.status} IN ('not-started', 'in-progress', 'complete', 'blocked')`,
		),
		check("chk_plans_phase", sql`${table.phase} >= 1`),
		check("chk_plans_is_active", sql`${table.is_active} IN (0, 1)`),
		check(
			"chk_plans_source_kind",
			sql`${table.source_kind} IN ('native', 'migrated')`,
		),
	],
);
