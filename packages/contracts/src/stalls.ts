// Delivery stalls (REQ-67 BC-6, BC-7): each stall is recorded against the item that caused it, with
// the question it raised, and each release counts its stalls by cause. Core writes a stall in the
// transaction of the act that starts it and ends it in the act that clears it
// (`packages/core/src/issues/stalls.ts`); nobody writes one by hand.

import { z } from "zod";

/**
 * Why delivery stalled. `unclear_item`: a question asked about a requirement or feedback item, or a
 * reporter's clarification; `defect`: a failed verdict reopened the issue, or a reopen named
 * `cause: defect` with its evidence (ISS-927); `waiting_on_person`: the
 * issue parked at `needs_info` on a person's answer, decision or resource.
 */
export const STALL_CAUSES = [
	"unclear_item",
	"defect",
	"waiting_on_person",
] as const;
export type StallCause = (typeof STALL_CAUSES)[number];

/**
 * The cause a reopen may name (`POST /api/issues/:id/transition` `cause`, ISS-927): `defect`, a defect
 * found in the work, starts a defect stall on the issue that its next merge mark ends. Decided only by
 * this field, never by reading the reason; a reopen naming none is a plain reopen and starts nothing.
 */
export const REOPEN_CAUSES = ["defect"] as const;
export type ReopenCause = (typeof REOPEN_CAUSES)[number];

/**
 * What a defect reopen cites as its proof, exactly one of: a verdict recorded on the issue, an
 * attachment on the issue or on one of its comments, or a live read (what was read, where, and what it
 * showed) in at most 2000 characters. Kept on the stall it starts.
 */
export const defectEvidenceSchema = z.union([
	z.strictObject({ verdictId: z.uuid() }),
	z.strictObject({ attachmentId: z.uuid() }),
	z.strictObject({ liveRead: z.string().trim().min(1).max(2000) }),
]);
export type DefectEvidence = z.infer<typeof defectEvidenceSchema>;

export const DEFECT_EVIDENCE_SHAPE_SENTENCE =
	'`evidence` is an object naming one proof: {"verdictId":"<uuid of a verdict on this issue>"}, {"attachmentId":"<uuid of an attachment on this issue or one of its comments>"}, or {"liveRead":"<what you read, where, and what it showed>"}; never a bare string';

/** How a stall ended: the act that cleared it. */
export const STALL_ENDINGS = [
	"answered",
	"withdrawn",
	"merged",
	"dropped",
	"resumed",
] as const;
export type StallEnding = (typeof STALL_ENDINGS)[number];

/** The writer's refusals: a stall the code cannot place is refused by name, never guessed. */
export const STALL_REFUSAL_CODES = [
	"STALL_CAUSE_UNKNOWN",
	"STALL_ITEM_MISSING",
	"STALL_ISSUE_MISSING",
	/** Evidence on a stall whose cause is not `defect`: only a defect reopen cites its proof (ISS-927). */
	"STALL_EVIDENCE_NOT_DEFECT",
] as const;
export type StallRefusalCode = (typeof STALL_REFUSAL_CODES)[number];

/** One stall as a release page lists it, behind its count. */
export interface ReleaseStall {
	cause: StallCause;
	/** The requirement or feedback item it stood on, where the cause names one. */
	item: { kind: "requirement" | "feedback"; key: string; title: string } | null;
	/** The issue it stalled, where it stalled one. */
	issue: { key: string; title: string } | null;
	/** The question it raised, where it raised one. */
	question: string | null;
	startedAt: string;
	/** Null while it stands: an open stall is shown open, never dropped. */
	endedAt: string | null;
}

/** A release's stalls: counted by cause, each one listed on demand. */
export interface ReleaseStalls {
	counts: Record<StallCause, number>;
	stalls: ReleaseStall[];
}
