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
// itself, and the copy follows it, so no memory list offers either act on them.
export const MEMORY_MIRROR_SOURCES = ["issue", "comment", "job"] as const;

// The sources a memory list reads unless asked otherwise: what agents and people wrote down, not
// the issue mirrors the tracker already shows.
export const MEMORY_AUTHORED_SOURCES = ["note", "knowledge", "policy", "decision"] as const;

// A record a memory names that no longer resolves in the project: the reason it reads stale.
export const MEMORY_STALE_WHYS = ["missing", "dropped", "archived"] as const;
export type MemoryStaleWhy = (typeof MEMORY_STALE_WHYS)[number];

export interface MemoryStaleRef {
	/** The key as the memory names it (`ISS-12`, `REQ-4`), or a workflow's flow. */
	ref: string;
	kind: "issue" | "requirement" | "workflow";
	why: MemoryStaleWhy;
	/** The project the key was read in, by slug, when the memory places it in another project. */
	project?: string;
}

export const MEMORY_CITE_KINDS = ["issue", "requirement", "workflow", "commit", "release"] as const;
export type MemoryCiteKind = (typeof MEMORY_CITE_KINDS)[number];

/**
 * One source a memory names, as the reader links it (MJ-6). An issue or requirement key is read in
 * the project the text places it in — this one unless a sibling project is named beside it — and a
 * key the text places in a project it does not name is `unchecked`, never read against this
 * project's numbers. A sibling is read only for a reader who may read it: a key placed in one they
 * may not read is `unchecked` with no project, the same as one placed in a project not named. A workflow has no key: the text names it by its flow, as a whole word, and it
 * is read in this project only (REQ-33 BC-4). A commit links to the project's repository and is not
 * checked; a release is a cite only when the project has that release.
 */
export interface MemoryCite {
	ref: string;
	kind: MemoryCiteKind;
	/** Slug of the project the cite was read in; null when the memory places it in a project it does not name, or in one the reader may not read. */
	project: string | null;
	state: "resolved" | "gone" | "unchecked";
	/** Set when `state` is `gone`. */
	why?: MemoryStaleWhy;
	/** When a resolved issue or requirement last changed: a memory written or checked before it reads `changed`. */
	changedAt?: string;
	/** A commit's page on the project's repository host. */
	url?: string;
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

/** A memory as a person reads it on the record it names. */
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
	/** The person who checked it then; null when an agent did, or the row was checked before checks were stamped. */
	verifiedBy: MemoryActor | null;
	/** The issue and requirement keys the text names, as written. */
	cites: MemoryCite[];
	/** Each cited record that no longer resolves; empty when every one does. */
	staleRefs: MemoryStaleRef[];
	/** Why it needs a check, in `MEMORY_CHECK_REASONS` order; empty when it holds, and on a retired row. */
	needsCheck: MemoryCheckReason[];
	/** The cites that changed after it was last written or checked: what `changed` names. */
	changed: MemoryCite[];
	/**
	 * A release later flagged the row as possibly outdated (a model's guess): when, by which issue,
	 * and the reason it gave — null only on a flag written by hand, which the reader says has none.
	 */
	flagged: { since: string; by: string | null; reason: string | null } | null;
	corrections: MemoryAct[];
	retired: MemoryAct | null;
	archivedAt: string | null;
	/** Why the row is archived when no person retired it; null when nothing recorded why. */
	archivedBy: MemoryArchiveCause | null;
}

/**
 * Why a row no person retired was archived, as facts a reader words in its own language: decay's
 * unused rule, decay's rule for a flag nobody confirmed (and the issue that flagged it), an
 * agent's outdated verdict with its evidence (written text), or a cause recorded in words core
 * does not hold a rule for (written text, shown as written).
 */
export type MemoryArchiveCause =
	| { rule: "unused" }
	| { rule: "flagged"; by: string | null }
	| { rule: "outdated"; evidence: string }
	| { rule: "recorded"; text: string };

export const MEMORY_ENTRY_STATES = ["live", "stale", "retired"] as const;
export type MemoryEntryState = (typeof MEMORY_ENTRY_STATES)[number];

/** A memory nobody has checked for this many days, since it was written or last checked, is due one. */
export const MEMORY_CHECK_AFTER_DAYS = 3;

/**
 * Why a current memory needs a check, each a fact the reader can act on: nobody checked it for
 * `MEMORY_CHECK_AFTER_DAYS` days (`unchecked`), a record it cites changed after it was last written
 * or checked (`changed`), a record it cites no longer resolves (`gone`), or a release flagged it
 * (`flagged`). A memory with none of them holds; the `stale` list is every memory with one.
 */
export const MEMORY_CHECK_REASONS = ["unchecked", "changed", "gone", "flagged"] as const;
export type MemoryCheckReason = (typeof MEMORY_CHECK_REASONS)[number];

export interface MemoryEntriesResponse {
	items: MemoryEntry[];
	/** How many rows each list holds for the same words and sources, whichever list was read. */
	counts: Record<MemoryEntryState, number>;
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
