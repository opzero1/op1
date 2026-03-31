import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger, setLoggerSink } from "../logging.js";

const originalStdErrLogs = Bun.env.OP1_PLUGIN_STDERR_LOGS;
const originalWorkspaceLogLevel = Bun.env.OP7_WORKSPACE_LOG_LEVEL;

afterEach(() => {
	setLoggerSink(null);

	if (originalStdErrLogs === undefined) {
		delete Bun.env.OP1_PLUGIN_STDERR_LOGS;
	} else {
		Bun.env.OP1_PLUGIN_STDERR_LOGS = originalStdErrLogs;
	}

	if (originalWorkspaceLogLevel === undefined) {
		delete Bun.env.OP7_WORKSPACE_LOG_LEVEL;
	} else {
		Bun.env.OP7_WORKSPACE_LOG_LEVEL = originalWorkspaceLogLevel;
	}
});

describe("workspace logger", () => {
	test("routes logs through the active sink even when logger was created earlier", async () => {
		Bun.env.OP7_WORKSPACE_LOG_LEVEL = "DEBUG";
		const entries: Array<{
			service: string;
			level: string;
			message: string;
			extra?: Record<string, unknown>;
		}> = [];
		const logger = createLogger("workspace.test");

		setLoggerSink((entry) => {
			entries.push(entry);
		});

		logger.error("non-fatal compaction failure", {
			sessionID: "session-1",
		});

		await Promise.resolve();

		expect(entries).toEqual([
			{
				service: "workspace.test",
				level: "error",
				message: "non-fatal compaction failure",
				extra: {
					sessionID: "session-1",
				},
			},
		]);
	});

	test("does not write to stderr unless explicitly enabled", () => {
		Bun.env.OP7_WORKSPACE_LOG_LEVEL = "DEBUG";
		delete Bun.env.OP1_PLUGIN_STDERR_LOGS;
		const writeSpy = spyOn(Bun, "write");
		const logger = createLogger("workspace.test");

		logger.error("hidden");

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});
});
