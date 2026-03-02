const SENSITIVE_KEYS = [
	"password",
	"token",
	"secret",
	"api_key",
	"apikey",
	"authorization",
	"cookie",
	"email",
	"phone",
] as const;

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

function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return SENSITIVE_KEYS.some((fragment) => normalized.includes(fragment));
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") {
		return redactText(value);
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, seen));
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	if (seen.has(value)) {
		return "[REDACTED_CYCLE]";
	}
	seen.add(value);

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};

	for (const [key, nestedValue] of Object.entries(input)) {
		if (isSensitiveKey(key)) {
			output[key] = "[REDACTED]";
			continue;
		}
		output[key] = redactValue(nestedValue, seen);
	}

	return output;
}

export function redactUnknown(value: unknown): unknown {
	return redactValue(value, new WeakSet<object>());
}
