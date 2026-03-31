import {
	normalizePath,
	runCommand,
	toWorkspacePath,
	truncateText,
} from "./shared.js";

type DiffStatus =
	| "added"
	| "copied"
	| "deleted"
	| "modified"
	| "renamed"
	| "type-changed"
	| "unmerged"
	| "unknown";

export interface RepoDiffEntry {
	path: string;
	status: DiffStatus;
	additions: number | null;
	deletions: number | null;
	staged: boolean;
}

export interface RepoTreeEntry {
	path: string;
	fileCount: number;
	samples: string[];
}

export interface RepoSnapshot {
	workspaceRoot: string;
	branch: string | null;
	trackedFiles: string[];
	tree: RepoTreeEntry[];
	diff: RepoDiffEntry[];
	generatedAt: string;
}

export interface RepoSnapshotOptions {
	maxTrackedFiles?: number;
	maxTreeEntries?: number;
	maxSamplesPerTreeEntry?: number;
	maxDiffEntries?: number;
}

const STATUS_MAP: Record<string, DiffStatus> = {
	A: "added",
	C: "copied",
	D: "deleted",
	M: "modified",
	R: "renamed",
	T: "type-changed",
	U: "unmerged",
};

function summarizeTree(
	paths: string[],
	maxEntries: number,
	maxSamples: number,
): RepoTreeEntry[] {
	const groups = new Map<string, { fileCount: number; samples: string[] }>();

	for (const path of paths) {
		const parts = path.split("/");
		const key = parts.length > 1 ? parts[0] : path;
		const group = groups.get(key) ?? { fileCount: 0, samples: [] };
		group.fileCount += 1;
		if (group.samples.length < maxSamples) {
			group.samples.push(path);
		}
		groups.set(key, group);
	}

	return [...groups.entries()]
		.map(([path, group]) => ({
			path,
			fileCount: group.fileCount,
			samples: group.samples.map((sample) => truncateText(sample, 120)),
		}))
		.sort((left, right) => {
			if (right.fileCount !== left.fileCount) {
				return right.fileCount - left.fileCount;
			}
			return left.path.localeCompare(right.path);
		})
		.slice(0, maxEntries);
}

function parseDiff(
	numstat: string | null,
	nameStatus: string | null,
	staged: boolean,
): RepoDiffEntry[] {
	if (!numstat || !nameStatus) return [];

	const stats = new Map<
		string,
		{ additions: number | null; deletions: number | null }
	>();
	for (const line of numstat.split("\n")) {
		if (!line.trim()) continue;
		const [added, removed, filePath] = line.split("\t");
		if (!filePath) continue;
		stats.set(normalizePath(filePath), {
			additions: added === "-" ? null : Number(added),
			deletions: removed === "-" ? null : Number(removed),
		});
	}

	const entries: RepoDiffEntry[] = [];
	for (const line of nameStatus.split("\n")) {
		if (!line.trim()) continue;
		const [rawStatus, ...rest] = line.split("\t");
		const path = normalizePath(rest[rest.length - 1] ?? "");
		if (!path) continue;
		const status = STATUS_MAP[rawStatus?.charAt(0) ?? ""] ?? "unknown";
		const stat = stats.get(path) ?? { additions: null, deletions: null };
		entries.push({
			path,
			status,
			additions: stat.additions,
			deletions: stat.deletions,
			staged,
		});
	}

	return entries;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for await (const file of new Bun.Glob("**/*").scan({
		cwd: root,
		onlyFiles: true,
		absolute: true,
	})) {
		const workspacePath = toWorkspacePath(root, file);
		if (
			workspacePath.startsWith(".git/") ||
			workspacePath.startsWith("node_modules/") ||
			workspacePath.startsWith(".opencode/") ||
			workspacePath.startsWith(".tmp/") ||
			workspacePath.startsWith(".tmp-home/") ||
			workspacePath.includes("/dist/")
		) {
			continue;
		}
		files.push(workspacePath);
	}
	return files.sort((left, right) => left.localeCompare(right));
}

export async function collectRepoSnapshot(
	workspaceRoot: string,
	options: RepoSnapshotOptions = {},
): Promise<RepoSnapshot> {
	const maxTrackedFiles = options.maxTrackedFiles ?? 4000;
	const maxTreeEntries = options.maxTreeEntries ?? 16;
	const maxSamplesPerTreeEntry = options.maxSamplesPerTreeEntry ?? 4;
	const maxDiffEntries = options.maxDiffEntries ?? 40;

	const branch = await runCommand(
		["git", "rev-parse", "--abbrev-ref", "HEAD"],
		workspaceRoot,
	);
	const tracked = await runCommand(["git", "ls-files"], workspaceRoot);
	const trackedFiles = tracked
		? tracked
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => normalizePath(line.trim()))
				.sort((left, right) => left.localeCompare(right))
				.slice(0, maxTrackedFiles)
		: (await listWorkspaceFiles(workspaceRoot)).slice(0, maxTrackedFiles);

	const [unstagedNumstat, unstagedStatus, stagedNumstat, stagedStatus] =
		await Promise.all([
			runCommand(["git", "diff", "--numstat", "HEAD"], workspaceRoot),
			runCommand(["git", "diff", "--name-status", "HEAD"], workspaceRoot),
			runCommand(["git", "diff", "--numstat", "--cached"], workspaceRoot),
			runCommand(["git", "diff", "--name-status", "--cached"], workspaceRoot),
		]);

	const diff = [
		...parseDiff(unstagedNumstat, unstagedStatus, false),
		...parseDiff(stagedNumstat, stagedStatus, true),
	]
		.sort((left, right) => {
			if (left.staged !== right.staged) return left.staged ? -1 : 1;
			return left.path.localeCompare(right.path);
		})
		.slice(0, maxDiffEntries);

	return {
		workspaceRoot: normalizePath(workspaceRoot),
		branch: branch && branch !== "HEAD" ? branch : null,
		trackedFiles,
		tree: summarizeTree(trackedFiles, maxTreeEntries, maxSamplesPerTreeEntry),
		diff,
		generatedAt: new Date().toISOString(),
	};
}

export function snapshotPaths(snapshot: RepoSnapshot): string[] {
	const diffPaths = snapshot.diff.map((entry) => entry.path);
	const treePaths = snapshot.tree.flatMap((entry) => entry.samples);
	return [...new Set([...diffPaths, ...treePaths])];
}
