// The browser's copy of the comment-intent and record-event vocabulary core owns (ISS-56). Neither
// package may import a runtime value from the other, so these constants are a second declaration on
// purpose, and `packages/core/src/issues/record-events/kinds-parity.test.ts` keeps them identical.

/** What a person or agent means a comment to do. Three values, never more (data-model review). */
export const COMMENT_INTENTS = ["question", "decision", "note"] as const;
export type CommentIntent = (typeof COMMENT_INTENTS)[number];

/** What a comment is about: the one arc target it belongs to. Only issues exist today. */
export const COMMENT_SCOPES = ["issue"] as const;
export type CommentScope = (typeof COMMENT_SCOPES)[number];

/**
 * Kernel evidence: kept for as long as the issue is. Retention never collapses one of these, and
 * `NarrationRecordKind` below is typed so that it cannot name one.
 */
export const KERNEL_RECORD_KINDS = [
	"verdict",
	"transition",
	"landing",
	"park",
	"correction",
] as const;
export type KernelRecordKind = (typeof KERNEL_RECORD_KINDS)[number];

/**
 * Agent narration: collapsed into one digest per issue once the issue has been terminal for
 * `NARRATION_COLLAPSE_DAYS` (req-feedback decision Q6).
 */
export const NARRATION_RECORD_KINDS = [
	"fold",
	"routed",
	"gap",
	"baseline",
] as const satisfies readonly Exclude<RecordEventKind, KernelRecordKind>[];
export type NarrationRecordKind = (typeof NARRATION_RECORD_KINDS)[number];

/** Kinds that are neither: kept, and not kernel evidence any gate reads. */
export const KEPT_RECORD_KINDS = [
	"decision",
	"question",
	"answer",
	"confirmation",
	"superseded",
	"review",
	"finding",
	"triage",
	"folded",
	"declined",
	"wave",
	"verification",
] as const;

/**
 * Every kind a record event may carry: the closed set. A kind outside it is refused by name
 * (`EVENT_KIND_UNKNOWN`), and `activity_log_record_kind_chk` refuses it again at the table.
 */
export const RECORD_EVENT_KINDS = [
	"verdict",
	"transition",
	"landing",
	"park",
	"correction",
	"fold",
	"routed",
	"gap",
	"baseline",
	"decision",
	"question",
	"answer",
	"confirmation",
	"superseded",
	"review",
	"finding",
	"triage",
	"folded",
	"declined",
	"wave",
	"verification",
] as const;
export type RecordEventKind = (typeof RECORD_EVENT_KINDS)[number];

/** The row a collapse leaves behind in place of an issue's narration. Never written by a caller. */
export const RECORD_DIGEST_KIND = "digest";

/** `activity_log.action` of a record event: `record.<kind>`. */
export const RECORD_ACTION_PREFIX = "record.";

/** Days an issue stays terminal before its narration collapses (decision Q6). */
export const NARRATION_COLLAPSE_DAYS = 180;

export interface RecordEventFieldView {
	readonly key: string;
	readonly value: string;
}

/** One record event as `GET /api/issues/:id/events` serves it. */
export interface RecordEventView {
	readonly id: string;
	readonly issueId: string;
	readonly kind: RecordEventKind | typeof RECORD_DIGEST_KIND;
	readonly contract: number;
	readonly fields: readonly RecordEventFieldView[];
	readonly lead: string | null;
	/** The comment this event was mirrored from, while forge-plugin still posts records as comments. */
	readonly commentId: string | null;
	/** On a digest only: how many narration events of each kind it replaced. */
	readonly counts?: Readonly<Record<string, number>>;
	readonly actorType: string;
	readonly actorId: string;
	readonly createdAt: string;
}
