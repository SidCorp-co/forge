// The browser's copy of the comment-intent and record-event vocabulary core owns (ISS-56). Neither
// package may import a runtime value from the other, so these constants are a second declaration on
// purpose, and `packages/core/src/issues/record-events/kinds.test.ts` keeps them identical.

/** What a person or agent means a comment to do. Three values, never more (data-model review). */
export const COMMENT_INTENTS = ["question", "decision", "note"] as const;
export type CommentIntent = (typeof COMMENT_INTENTS)[number];

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

// cm:why core alone writes these, in the act's transaction (EVENT_KIND_KERNEL_ONLY)
export const KERNEL_ONLY_RECORD_KINDS = [
	"transition",
	"park",
	"verdict",
] as const satisfies readonly KernelRecordKind[];
export type KernelOnlyRecordKind = (typeof KERNEL_ONLY_RECORD_KINDS)[number];

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

export const RECORD_DIGEST_KIND = "digest";

export const RECORD_ACTION_PREFIX = "record.";

export const NARRATION_COLLAPSE_DAYS = 180;

export interface RecordEventFieldView {
	readonly key: string;
	readonly value: string;
}

export interface RecordEventView {
	readonly id: string;
	readonly issueId: string;
	readonly kind: RecordEventKind | typeof RECORD_DIGEST_KIND;
	readonly contract: number;
	readonly fields: readonly RecordEventFieldView[];
	readonly lead: string | null;
	readonly commentId: string | null;
	readonly counts?: Readonly<Record<string, number>>;
	readonly writer: "core" | "client";
	readonly actorType: string;
	readonly actorId: string;
	readonly createdAt: string;
}
