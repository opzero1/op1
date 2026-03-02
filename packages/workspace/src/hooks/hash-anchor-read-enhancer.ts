import { buildHashAnchor } from "../hash-anchor/contract.js";

interface HashAnchorReadEnhancerInput {
	tool: string;
}

interface HashAnchorReadEnhancerOutput {
	output?: string;
}

interface NumberedLine {
	index: number;
	lineNumber: number;
	content: string;
}

const NUMBERED_LINE_PATTERN = /^(\d+):\s?(.*)$/;

function parseNumberedLines(lines: string[]): NumberedLine[] {
	const parsed: NumberedLine[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const match = line.match(NUMBERED_LINE_PATTERN);
		if (!match) continue;

		const lineNumber = Number.parseInt(match[1] || "", 10);
		if (!Number.isFinite(lineNumber) || lineNumber < 1) continue;

		parsed.push({
			index,
			lineNumber,
			content: match[2] ?? "",
		});
	}

	return parsed;
}

export function enhanceReadOutputWithAnchors(output: string): string {
	const lines = output.split("\n");
	const numberedLines = parseNumberedLines(lines);
	if (numberedLines.length === 0) return output;

	for (let index = 0; index < numberedLines.length; index += 1) {
		const current = numberedLines[index];
		const previous = numberedLines[index - 1]?.content;
		const next = numberedLines[index + 1]?.content;
		const anchor = buildHashAnchor(current.lineNumber, current.content, {
			previous,
			next,
		});
		lines[current.index] = `${anchor}| ${current.content}`;
	}

	return lines.join("\n");
}

export function createHashAnchorReadEnhancerHook(options?: {
	enabled?: boolean;
}) {
	const enabled = options?.enabled ?? false;

	return async (
		input: HashAnchorReadEnhancerInput,
		output: HashAnchorReadEnhancerOutput,
	): Promise<void> => {
		if (!enabled) return;
		if (input.tool.toLowerCase() !== "read") return;
		if (typeof output.output !== "string") return;

		output.output = enhanceReadOutputWithAnchors(output.output);
	};
}
