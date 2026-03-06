import type { TaskStateManager } from "./state.js";

const ID_WORDS_A = [
	"agile",
	"amber",
	"brisk",
	"calm",
	"clear",
	"cosmic",
	"crisp",
	"daring",
	"eager",
	"gentle",
	"golden",
	"lively",
	"mighty",
	"nimble",
	"proud",
	"quiet",
	"rapid",
	"silver",
	"steady",
	"swift",
] as const;

const ID_WORDS_B = [
	"aqua",
	"aurora",
	"beacon",
	"cedar",
	"dawn",
	"ember",
	"forest",
	"harbor",
	"jade",
	"lagoon",
	"maple",
	"meadow",
	"neon",
	"ocean",
	"orchid",
	"pixel",
	"rocket",
	"sierra",
	"solar",
	"tidal",
] as const;

const ID_WORDS_C = [
	"anchor",
	"badger",
	"falcon",
	"harvest",
	"island",
	"lantern",
	"mariner",
	"nebula",
	"otter",
	"pioneer",
	"quartz",
	"ranger",
	"sailor",
	"summit",
	"trail",
	"vector",
	"voyager",
	"whisper",
	"yonder",
	"zephyr",
] as const;

function pick<const T extends readonly string[]>(entries: T): T[number] {
	return entries[Math.floor(Math.random() * entries.length)] as T[number];
}

function createCandidate(): string {
	return [pick(ID_WORDS_A), pick(ID_WORDS_B), pick(ID_WORDS_C)].join("-");
}

export async function generateTaskID(state: TaskStateManager): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const candidate = createCandidate();
		const existing = await state.getTask(candidate);
		if (!existing) return candidate;
	}

	throw new Error("Unable to generate a unique task id.");
}
