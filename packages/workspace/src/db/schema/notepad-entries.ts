/**
 * notepad_entries table
 *
 * Append-only memory log for learnings/issues/decisions.
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
import { plans } from "./plans";

export const notepadEntries = sqliteTable(
	"notepad_entries",
	{
		id: text("id").primaryKey(),
		project_scope_id: text("project_scope_id").notNull(),
		plan_id: text("plan_id").notNull(),
		category: text("category").notNull(),
		content: text("content").notNull(),
		content_hash: text("content_hash").notNull(),
		source_kind: text("source_kind").notNull().default("native"),
		source_position: integer("source_position"),
		time_created: integer("time_created").notNull(),
	},
	(table) => [
		// Foreign keys
		foreignKey({
			name: "fk_notepad_entries_project_scope_id",
			columns: [table.project_scope_id],
			foreignColumns: [projectScopes.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_notepad_entries_plan_id",
			columns: [table.plan_id],
			foreignColumns: [plans.id],
		}).onDelete("cascade"),

		// Unique constraints
		uniqueIndex("uq_notepad_entries_dedupe").on(
			table.plan_id,
			table.category,
			table.content_hash,
			table.source_position,
		),

		// Indexes
		index("idx_notepad_entries_plan_category_time").on(
			table.plan_id,
			table.category,
			table.time_created,
		),
		index("idx_notepad_entries_scope_time").on(
			table.project_scope_id,
			table.time_created,
		),

		// Check constraints
		check(
			"chk_notepad_entries_category",
			sql`${table.category} IN ('learnings', 'issues', 'decisions')`,
		),
		check(
			"chk_notepad_entries_source_kind",
			sql`${table.source_kind} IN ('native', 'migrated')`,
		),
		check(
			"chk_notepad_entries_time_created",
			sql`${table.time_created} > 0`,
		),
	],
);
