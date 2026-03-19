const PII_PATTERNS = [
	/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
	/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi,
	/(token\s*[=:]\s*)[^\s,;]+/gi,
	/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
	/([?&](?:token|api_key|apikey|secret)=)[^&\s]+/gi,
] as const;

export function redactText(text: string): string {
	let result = text;
	for (const pattern of PII_PATTERNS) {
		result = result.replace(pattern, (...args: unknown[]) => {
			const full = typeof args[0] === "string" ? args[0] : "";
			const group = typeof args[1] === "string" ? args[1] : "";
			if (group) return `${group}[REDACTED]`;
			if (full.includes("@")) return "[REDACTED_EMAIL]";
			return "[REDACTED]";
		});
	}
	return result;
}
