import type { RefusalStatuses } from "./refusal.js";

// The codes a memory write, a recall verdict or a person's correct and retire refuse under.

export const MEMORY_REFUSAL_CODES = [
	"MEMORY_REFUSED",
	"MEMORY_TEXT_TOO_LONG",
	"MEMORY_CODE_BLOCK_TOO_LONG",
	"MEMORY_EVIDENCE_REQUIRED",
	"MEMORY_NOT_FOUND",
	"MEMORY_MIRROR_READ_ONLY",
	"MEMORY_ALREADY_RETIRED",
	"MEMORY_UNCHANGED",
] as const;

export type MemoryRefusalCode = (typeof MEMORY_REFUSAL_CODES)[number];

export const MEMORY_REFUSAL_STATUSES = {
	MEMORY_NOT_FOUND: 404,
	MEMORY_ALREADY_RETIRED: 409,
} as const satisfies RefusalStatuses<MemoryRefusalCode>;

// Sources that copy another record (an issue's text, a comment, a job): a person corrects the record
// itself, and the copy follows it, so the Memory page offers neither act on them.
export const MEMORY_MIRROR_SOURCES = ["issue", "comment", "job"] as const;

// The sources the Memory page lists unless asked otherwise: what agents and people wrote down, not
// the issue mirrors the tracker already shows.
export const MEMORY_AUTHORED_SOURCES = ["note", "knowledge", "policy", "decision"] as const;

// A record a memory names that no longer resolves in the project: the reason it reads stale.
export const MEMORY_STALE_WHYS = ["missing", "dropped", "archived"] as const;
export type MemoryStaleWhy = (typeof MEMORY_STALE_WHYS)[number];

export interface MemoryStaleRef {
	/** The key as the memory names it: `ISS-12`, `REQ-4`. */
	ref: string;
	kind: "issue" | "requirement";
	why: MemoryStaleWhy;
}

/** The person or agent account behind a write or an act. */
export interface MemoryActor {
	id: string;
	name: string;
	agent: boolean;
}

/** One person's correction or retirement, kept on the row it changed. */
export interface MemoryAct {
	by: MemoryActor | null;
	at: string;
	reason: string;
}

/** A memory as the project's Memory page reads it. */
export interface MemoryEntry {
	id: string;
	source: string;
	sourceRef: string;
	text: string;
	writtenAt: string;
	updatedAt: string;
	/** Who last wrote the body; null for a row written before writes were stamped. */
	writtenBy: MemoryActor | null;
	/** When an agent or person last checked it against what is live; null when never. */
	verifiedAt: string | null;
	/** The issue and requirement keys the text names, as written. */
	cites: string[];
	/** Each cited record that no longer resolves; empty when every one does. */
	staleRefs: MemoryStaleRef[];
	/** A release later flagged the row as possibly outdated (a model's guess): when, and by which issue. */
	flagged: { since: string; by: string | null } | null;
	corrections: MemoryAct[];
	retired: MemoryAct | null;
	/** Why the row is archived when no person retired it: the decay rule, or a recall verdict. */
	archivedAt: string | null;
	archivedBy: string | null;
}

export const MEMORY_ENTRY_STATES = ["live", "stale", "retired"] as const;
export type MemoryEntryState = (typeof MEMORY_ENTRY_STATES)[number];

export interface MemoryEntriesResponse {
	items: MemoryEntry[];
	returned: number;
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
}

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
