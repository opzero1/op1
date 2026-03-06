export interface McpPointerAvailability {
	serverId: string;
	requirement: "required" | "optional";
	available: boolean;
}

export interface McpPointerEnforcementResult {
	ok: boolean;
	blockingRequired: string[];
	degradedOptional: string[];
}

export function enforceMcpPointerAvailability(
	statuses: McpPointerAvailability[],
): McpPointerEnforcementResult {
	const blockingRequired: string[] = [];
	const degradedOptional: string[] = [];

	for (const status of statuses) {
		if (status.available) {
			continue;
		}

		if (status.requirement === "required") {
			blockingRequired.push(status.serverId);
			continue;
		}

		degradedOptional.push(status.serverId);
	}

	return {
		ok: blockingRequired.length === 0,
		blockingRequired,
		degradedOptional,
	};
}
