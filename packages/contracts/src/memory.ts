// The codes a memory write or a recall verdict refuses under.

export const MEMORY_REFUSAL_CODES = [
	"MEMORY_REFUSED",
	"MEMORY_TEXT_TOO_LONG",
	"MEMORY_CODE_BLOCK_TOO_LONG",
	"MEMORY_EVIDENCE_REQUIRED",
] as const;

export type MemoryRefusalCode = (typeof MEMORY_REFUSAL_CODES)[number];
