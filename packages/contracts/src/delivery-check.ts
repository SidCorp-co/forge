// The check a requirement passes before its delivery starts (REQ-67 BC-1..BC-5): the questions still
// open about it, the gaps the kernel can see, and whether the steward has checked it since its head
// was agreed. The move into delivery is refused naming each open question and a missing check at
// once (`move-gates.ts:REQUIREMENT_CHECKED_GUARD`); a gap refuses nothing: the steward reads it and
// asks at most three questions about it, and those questions hold the move until answered.

/** What the kernel can see is missing before delivery starts. */
export const DELIVERY_GAP_KINDS = [
	/** The project draws workflows and the requirement names none it changes (BC-2, BC-3). */
	"no_workflow",
	/** A linked workflow no live criterion traces a step of, so its picture lights nothing (BC-2). */
	"untraced_workflow",
	/** The intake draft found it contradicting a live requirement's criterion, and nobody decided it (BC-3). */
	"conflict",
	/** The intake draft found it repeating a live requirement, and nobody decided it (BC-3). */
	"duplicate",
] as const;
export type DeliveryGapKind = (typeof DELIVERY_GAP_KINDS)[number];

export interface DeliveryGap {
	kind: DeliveryGapKind;
	/** The workflow (its flow key) or the requirement (REQ-n) the gap names; null for `no_workflow`. */
	ref: string | null;
	/** That record's title; null for `no_workflow`. */
	title: string | null;
	/** One sentence naming the gap and what closes it, as the refusal says it. */
	detail: string;
}

export interface DeliveryCheckQuestion {
	id: string;
	prompt: string;
	askedAt: string;
}

export interface RequirementDeliveryCheck {
	/** Whether the project's steward is on, so a check by it is owed before delivery. */
	owed: boolean;
	/** When the steward last finished a check of it since its head was agreed; null where none has. */
	checkedAt: string | null;
	/** The questions still open about it, oldest first. */
	questions: DeliveryCheckQuestion[];
	gaps: DeliveryGap[];
	/** Nothing of the check holds the move into delivery: no open question, and checked where owed. */
	clear: boolean;
}

/** The most questions the steward keeps open about one item (BC-4). */
export const STEWARD_OPEN_ASKS_MAX = 3;
