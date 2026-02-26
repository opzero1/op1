/**
 * plan_sessions table
 *
 * Tracks all sessions that worked on a plan.
 * Composite primary key (plan_id, session_id).
 * See ADR-0002 for the full contract.
 */

import {
	sqliteTable,
	text,
	integer,
	primaryKey,
	index,
	check,
	foreignKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { plans } from "./plans";

export const planSessions = sqliteTable(
	"plan_sessions",
	{
		plan_id: text("plan_id").notNull(),
		session_id: text("session_id").notNull(),
		time_linked: integer("time_linked").notNull(),
	},
	(table) => [
		// Composite primary key
		primaryKey({
			name: "pk_plan_sessions",
			columns: [table.plan_id, table.session_id],
		}),

		// Foreign keys
		foreignKey({
			name: "fk_plan_sessions_plan_id",
			columns: [table.plan_id],
			foreignColumns: [plans.id],
		}).onDelete("cascade"),

		// Indexes
		index("idx_plan_sessions_session_id").on(table.session_id),

		// Check constraints
		check(
			"chk_plan_sessions_time_linked",
			sql`${table.time_linked} > 0`,
		),
	],
);
