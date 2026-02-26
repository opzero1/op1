/**
 * project_scopes table
 *
 * Represents one logical project identity used to isolate all workspace memory.
 * See ADR-0002 for the full contract.
 */

import {
	sqliteTable,
	text,
	integer,
	uniqueIndex,
	index,
	check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projectScopes = sqliteTable(
	"project_scopes",
	{
		id: text("id").primaryKey(),
		scope_key: text("scope_key").notNull(),
		repo_root_path: text("repo_root_path").notNull(),
		workspace_root_path: text("workspace_root_path").notNull(),
		repo_remote_url: text("repo_remote_url"),
		repo_default_branch: text("repo_default_branch"),
		time_created: integer("time_created").notNull(),
		time_updated: integer("time_updated").notNull(),
	},
	(table) => [
		uniqueIndex("uq_project_scopes_scope_key").on(table.scope_key),
		index("idx_project_scopes_repo_root_path").on(table.repo_root_path),
		check("chk_project_scopes_time_created", sql`${table.time_created} > 0`),
		check("chk_project_scopes_time_updated", sql`${table.time_updated} > 0`),
	],
);
