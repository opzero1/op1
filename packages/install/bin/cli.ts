#!/usr/bin/env bun
/**
 * op1 CLI - Interactive installer for OpenCode harness
 * Usage: bunx @op1/install
 */

import { main } from "@/index";

const args = Bun.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-n");

main({ dryRun }).catch((error) => {
	console.error("Error:", error);
	throw error;
});
