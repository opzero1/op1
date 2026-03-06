export function isSystemError(
	error: unknown,
): error is Error & { code: string } {
	return error instanceof Error && "code" in error;
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
