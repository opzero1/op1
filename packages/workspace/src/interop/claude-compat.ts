import { homedir, join } from "../bun-compat.js";

type ClaudeCompatAssetType = "commands" | "skills" | "agents" | "hooks" | "mcp";

interface ClaudeCompatRoot {
	scope: "global" | "project";
	source: ".claude" | ".agents";
	path: string;
}

export interface ClaudeCompatAsset {
	type: ClaudeCompatAssetType;
	root: string;
	scope: "global" | "project";
	source: ".claude" | ".agents";
	path: string;
}

export interface ClaudeCompatSnapshot {
	generated_at: string;
	roots: ClaudeCompatRoot[];
	totals: Record<ClaudeCompatAssetType, number>;
	assets: ClaudeCompatAsset[];
}

const ASSET_PATTERNS: Array<{
	type: ClaudeCompatAssetType;
	pattern: string;
}> = [
	{ type: "commands", pattern: "commands/**/*" },
	{ type: "skills", pattern: "skills/**/SKILL.md" },
	{ type: "agents", pattern: "agents/**/*" },
	{ type: "hooks", pattern: "hooks/**/*" },
	{ type: "mcp", pattern: "mcp/**/*" },
];

function buildRoots(
	directory: string,
	homeDirectory: string,
): ClaudeCompatRoot[] {
	return [
		{
			scope: "global",
			source: ".claude",
			path: join(homeDirectory, ".claude"),
		},
		{
			scope: "global",
			source: ".agents",
			path: join(homeDirectory, ".agents"),
		},
		{
			scope: "project",
			source: ".claude",
			path: join(directory, ".claude"),
		},
		{
			scope: "project",
			source: ".agents",
			path: join(directory, ".agents"),
		},
	];
}

async function scanRootAssets(
	root: ClaudeCompatRoot,
): Promise<ClaudeCompatAsset[]> {
	const assets: ClaudeCompatAsset[] = [];

	for (const descriptor of ASSET_PATTERNS) {
		try {
			for await (const relativePath of new Bun.Glob(descriptor.pattern).scan({
				cwd: root.path,
				onlyFiles: true,
				absolute: false,
				dot: true,
			})) {
				assets.push({
					type: descriptor.type,
					root: root.path,
					scope: root.scope,
					source: root.source,
					path: relativePath,
				});
			}
		} catch {
			// Missing roots are expected.
		}
	}

	return assets;
}

export async function discoverClaudeCompatAssets(input: {
	directory: string;
	homeDirectory?: string;
}): Promise<ClaudeCompatSnapshot> {
	const roots = buildRoots(input.directory, input.homeDirectory ?? homedir());
	const assetsByRoot = await Promise.all(
		roots.map((root) => scanRootAssets(root)),
	);
	const assets = assetsByRoot.flat();

	const totals: Record<ClaudeCompatAssetType, number> = {
		commands: 0,
		skills: 0,
		agents: 0,
		hooks: 0,
		mcp: 0,
	};

	for (const asset of assets) {
		totals[asset.type] += 1;
	}

	return {
		generated_at: new Date().toISOString(),
		roots,
		totals,
		assets,
	};
}
