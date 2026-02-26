import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: [
		"./src/db/schema/project-scopes.ts",
		"./src/db/schema/plans.ts",
		"./src/db/schema/plan-sessions.ts",
		"./src/db/schema/notepad-entries.ts",
		"./src/db/schema/worktree-refs.ts",
	],
	out: "./migration",
	dbCredentials: {
		url: ".opencode/workspace/workspace.db",
	},
});
