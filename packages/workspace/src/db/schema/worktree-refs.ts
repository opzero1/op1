/**
 * worktree_refs table
 *
 * Stores project worktree references to reduce repeated discovery calls.
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

export const worktreeRefs = sqliteTable(
	"worktree_refs",
	{
		id: text("id").primaryKey(),
		project_scope_id: text("project_scope_id").notNull(),
		worktree_path: text("worktree_path").notNull(),
		branch_name: text("branch_name").notNull(),
		base_branch: text("base_branch"),
		session_id: text("session_id"),
		status: text("status").notNull(),
		time_created: integer("time_created").notNull(),
		time_updated: integer("time_updated").notNull(),
	},
	(table) => [
		// Foreign keys
		foreignKey({
			name: "fk_worktree_refs_project_scope_id",
			columns: [table.project_scope_id],
			foreignColumns: [projectScopes.id],
		}).onDelete("cascade"),

		// Unique constraints
		uniqueIndex("uq_worktree_refs_scope_path").on(
			table.project_scope_id,
			table.worktree_path,
		),

		// Indexes
		index("idx_worktree_refs_scope_status").on(
			table.project_scope_id,
			table.status,
		),
		index("idx_worktree_refs_scope_branch").on(
			table.project_scope_id,
			table.branch_name,
		),

		// Check constraints
		check(
			"chk_worktree_refs_status",
			sql`${table.status} IN ('active', 'merged', 'closed', 'stale')`,
		),
	],
);
