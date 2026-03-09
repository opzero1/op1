import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { lspManager } from "../client";
import type { WorkspaceEdit } from "../types";
import { applyWorkspaceEdit, withLspClient } from "../utils";

const tempDirs: string[] = [];

afterEach(async () => {
	await lspManager.stopAll();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasStringField(
	value: Record<string, unknown>,
	field: string,
): value is Record<string, string> {
	return typeof value[field] === "string";
}

function isWorkspaceEdit(value: unknown): value is WorkspaceEdit {
	return isRecord(value) && ("changes" in value || "documentChanges" in value);
}

function positionOf(lineText: string, token: string): number {
	const index = lineText.indexOf(token);
	if (index === -1) {
		throw new Error(`Token '${token}' not found in '${lineText}'`);
	}
	return index;
}

async function createTsProject(): Promise<{
	brokenPath: string;
	defsPath: string;
	usePath: string;
}> {
	const tempRoot = join(import.meta.dir, "..", "..", "__tmp__");
	await mkdir(tempRoot, { recursive: true });
	const dir = await mkdtemp(join(tempRoot, "op1-lsp-smoke-"));
	tempDirs.push(dir);

	const defsPath = join(dir, "defs.ts");
	const usePath = join(dir, "use.ts");
	const brokenPath = join(dir, "broken.ts");

	await Bun.write(
		defsPath,
		[
			"export const sharedValue = 1;",
			"",
			"export function readSharedValue(): number {",
			"\treturn sharedValue;",
			"}",
		].join("\n"),
	);
	await Bun.write(
		usePath,
		[
			'import { readSharedValue, sharedValue } from "./defs";',
			"",
			"export function useSharedValue(): number {",
			"\treturn readSharedValue() + sharedValue;",
			"}",
		].join("\n"),
	);
	await Bun.write(
		brokenPath,
		["const broken: string = 1;", "", "export default broken;"].join("\n"),
	);

	return { brokenPath, defsPath, usePath };
}

describe("@op1/lsp smoke", () => {
	test(
		"workspace symbols bootstrap the project and core methods work on TypeScript",
		async () => {
		const { brokenPath, defsPath, usePath } = await createTsProject();

		const workspaceSymbolResult = await withLspClient(usePath, (client) =>
			client.workspaceSymbols("sharedValue", usePath),
		);
		expect(Array.isArray(workspaceSymbolResult)).toBe(true);
		if (!Array.isArray(workspaceSymbolResult) || workspaceSymbolResult.length === 0) {
			throw new Error("Expected workspace symbols to return at least one result");
		}
		const workspaceSymbol = workspaceSymbolResult.find(
			(item) => isRecord(item) && hasStringField(item, "name") && item.name === "sharedValue",
		);
		expect(workspaceSymbol).toBeDefined();

		const useLines = (await Bun.file(usePath).text()).split("\n");
		const defsLines = (await Bun.file(defsPath).text()).split("\n");

		const importedSharedValueChar = positionOf(useLines[0] ?? "", "sharedValue");
		const inlineSharedValueChar = positionOf(useLines[3] ?? "", "sharedValue");
		const declaredSharedValueChar = positionOf(defsLines[0] ?? "", "sharedValue");

		const definitionResult = await withLspClient(usePath, (client) =>
			client.definition(usePath, 4, inlineSharedValueChar),
		);
		expect(definitionResult).toBeTruthy();

		const referencesResult = await withLspClient(defsPath, (client) =>
			client.references(defsPath, 1, declaredSharedValueChar, true),
		);
		expect(Array.isArray(referencesResult)).toBe(true);
		if (!Array.isArray(referencesResult)) {
			throw new Error("Expected references to return an array");
		}
		expect(referencesResult.length).toBeGreaterThanOrEqual(3);

		const documentSymbolsResult = await withLspClient(usePath, (client) =>
			client.documentSymbols(usePath),
		);
		expect(Array.isArray(documentSymbolsResult)).toBe(true);
		if (!Array.isArray(documentSymbolsResult) || documentSymbolsResult.length === 0) {
			throw new Error("Expected document symbols to return at least one result");
		}

		const diagnosticsResult = await withLspClient(brokenPath, (client) =>
			client.diagnostics(brokenPath),
		);
		expect(diagnosticsResult.items.length).toBeGreaterThan(0);

		const prepareRenameResult = await withLspClient(defsPath, (client) =>
			client.prepareRename(defsPath, 1, declaredSharedValueChar),
		);
		expect(prepareRenameResult).toBeTruthy();

		const renameEdit = await withLspClient(defsPath, (client) =>
			client.rename(defsPath, 1, declaredSharedValueChar, "sharedValueRenamed"),
		);
		expect(isWorkspaceEdit(renameEdit)).toBe(true);
		if (!isWorkspaceEdit(renameEdit)) {
			throw new Error("Expected rename to return a workspace edit");
		}

		const applyResult = await applyWorkspaceEdit(renameEdit);
		expect(applyResult.success).toBe(true);

		const renamedDefs = await Bun.file(defsPath).text();
		const renamedUse = await Bun.file(usePath).text();
		expect(renamedDefs).toContain("sharedValueRenamed");
		expect(renamedUse).toContain("sharedValueRenamed");

		await lspManager.stopAll();

		const renamedSymbolResult = await withLspClient(usePath, (client) =>
			client.workspaceSymbols("sharedValueRenamed", usePath),
		);
		expect(Array.isArray(renamedSymbolResult)).toBe(true);
		if (!Array.isArray(renamedSymbolResult) || renamedSymbolResult.length === 0) {
			throw new Error("Expected renamed workspace symbols to return at least one result");
		}

		const renamedImportedChar = positionOf(
			(await Bun.file(usePath).text()).split("\n")[0] ?? "",
			"sharedValueRenamed",
		);
		const renamedDefinitionResult = await withLspClient(usePath, (client) =>
			client.definition(usePath, 1, renamedImportedChar),
		);
		expect(renamedDefinitionResult).toBeTruthy();

			expect(importedSharedValueChar).toBeGreaterThanOrEqual(0);
		},
		20000,
	);
});
