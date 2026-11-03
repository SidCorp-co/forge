// Delivery stalls (REQ-67 BC-6, BC-7): each stall is recorded against the item that caused it, with
// the question it raised, and each release counts its stalls by cause. Core writes a stall in the
// transaction of the act that starts it and ends it in the act that clears it
// (`packages/core/src/issues/stalls.ts`); nobody writes one by hand.

/**
 * Why delivery stalled. `unclear_item`: a question asked about a requirement or feedback item, or a
 * reporter's clarification; `defect`: a failed verdict reopened the issue; `waiting_on_person`: the
 * issue parked at `needs_info` on a person's answer, decision or resource.
 */
export const STALL_CAUSES = [
	"unclear_item",
	"defect",
	"waiting_on_person",
] as const;
export type StallCause = (typeof STALL_CAUSES)[number];

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
