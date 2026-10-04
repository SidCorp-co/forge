// The codes a memory write or a recall verdict refuses under.

export const MEMORY_REFUSAL_CODES = [
	"MEMORY_REFUSED",
	"MEMORY_TEXT_TOO_LONG",
	"MEMORY_CODE_BLOCK_TOO_LONG",
	"MEMORY_EVIDENCE_REQUIRED",
] as const;

export type MemoryRefusalCode = (typeof MEMORY_REFUSAL_CODES)[number];

// What a memory rerank grades each candidate, scored on its own against the query.
export const RERANK_GRADES = ["none", "weak", "partial", "strong"] as const;
export type RerankGrade = (typeof RERANK_GRADES)[number];

// Which path ordered a reranked search: the model's grades, or the fused (RRF) order.
const RERANK_PATHS = ["model", "rrf"] as const;
export type RerankPath = (typeof RERANK_PATHS)[number];

// Why a rerank that was asked for fell back to the fused order.
export const RERANK_DEGRADED_REASONS = [
	"unconfigured",
	"withheld",
	"failed",
	"unreadable",
] as const;
export type RerankDegradedReason = (typeof RERANK_DEGRADED_REASONS)[number];

// What a search reports about its rerank: the path that ordered the hits, the model version that
// graded them, and, when the model path was asked for and not taken, why and for how many.
export interface RerankReport {
	path: RerankPath;
	model?: string;
	degraded?: { reason: RerankDegradedReason; unscored: number; candidates: number };
}
