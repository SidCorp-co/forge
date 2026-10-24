// The comment-intent and record-event vocabulary (ISS-56): one declaration, read by core (its
// writes and `activity_log_record_kind_chk`) and by the browser.

import { z } from "zod";
import { REASON_SENTENCE_MAX } from "./reason-text.js";
import type { RefusalStatuses } from "./refusal.js";

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
	"withdrawal",
] as const;
type KernelRecordKind = (typeof KERNEL_RECORD_KINDS)[number];

// core alone writes these, in the act's transaction (EVENT_KIND_KERNEL_ONLY)
export const KERNEL_ONLY_RECORD_KINDS = [
	"transition",
	"park",
	"verdict",
	"withdrawal",
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
	"withdrawal",
] as const;
export type RecordEventKind = (typeof RECORD_EVENT_KINDS)[number];

export const RECORD_DIGEST_KIND = "digest";

export const RECORD_ACTION_PREFIX = "record.";

export const NARRATION_COLLAPSE_DAYS = 180;

/** Every `activity_log.action` a record event is stored under. */
export const RECORD_ACTIONS: readonly string[] = [
	...RECORD_EVENT_KINDS.map((kind) => `${RECORD_ACTION_PREFIX}${kind}`),
	`${RECORD_ACTION_PREFIX}${RECORD_DIGEST_KIND}`,
];

export function isRecordEventKind(kind: string | null | undefined): kind is RecordEventKind {
	return kind != null && (RECORD_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isKernelOnlyRecordKind(
	kind: string | null | undefined,
): kind is KernelOnlyRecordKind {
	return kind != null && (KERNEL_ONLY_RECORD_KINDS as readonly string[]).includes(kind);
}

export function isCommentIntent(intent: unknown): intent is CommentIntent {
	return typeof intent === "string" && (COMMENT_INTENTS as readonly string[]).includes(intent);
}

export function recordAction(kind: RecordEventKind | typeof RECORD_DIGEST_KIND): string {
	return `${RECORD_ACTION_PREFIX}${kind}`;
}

/**
 * The fields a caller's `decision` record carries (ISS-585): what was decided, why, until when, how
 * to reverse it and the assumption under it (the master's and a run's shape), `serves` and `none`
 * (the plugin's), and `lead`. A key outside them is refused by name (`EVENT_FIELD_UNKNOWN`). The
 * decisions core writes for its own acts (a feedback routing, a suggestion's outcome) are core's
 * records and carry their own keys.
 */
export const DECISION_RECORD_FIELDS = [
	"decision",
	"why",
	"until",
	"reverse",
	"assumption",
	"serves",
	"none",
	"lead",
] as const;

/**
 * The record kinds whose fields are a closed set, by kind. A kind not named here takes any key of
 * the field-name shape.
 */
export const RECORD_KIND_FIELDS: Readonly<
	Partial<Record<RecordEventKind, readonly string[]>>
> = { decision: DECISION_RECORD_FIELDS };

/** The record kinds a person or a run may withdraw (ISS-585): withdrawn, never deleted. */
export const WITHDRAWABLE_RECORD_KINDS = [
	"decision",
] as const satisfies readonly RecordEventKind[];

/** `POST /api/issues/:id/events/:eventId/withdraw`: why the record no longer stands. */
export const withdrawRecordRequestSchema = z.strictObject({
	reason: z.string().trim().min(1).max(REASON_SENTENCE_MAX),
});
export type WithdrawRecordRequest = z.infer<typeof withdrawRecordRequestSchema>;
export const WITHDRAW_RECORD_SHAPE = `{ reason } — why the decision no longer stands, at most ${REASON_SENTENCE_MAX} characters`;

/** `GET /api/issues/:id/events?withdrawn=include` keeps withdrawn records, each saying so. */
export const RECORD_WITHDRAWN_READS = ["exclude", "include"] as const;

export const RECORD_EVENT_REFUSAL_CODES = [
	"EVENT_REFUSED",
	"EVENT_KIND_UNKNOWN",
	"EVENT_KIND_KERNEL_ONLY",
	"EVENT_PAYLOAD_INVALID",
	"EVENT_FIELD_UNKNOWN",
	"EVENT_WITHDRAW_KIND",
	"EVENT_WITHDRAW_CORE_ACT",
	"EVENT_WITHDRAW_IN_COMMENT",
	"EVENT_ALREADY_WITHDRAWN",
	"EVENT_NOT_FOUND",
	"KERNEL_RECORD_IMMUTABLE",
] as const;
export type RecordEventRefusalCode = (typeof RECORD_EVENT_REFUSAL_CODES)[number];

export const RECORD_EVENT_REFUSAL_STATUSES = {
	EVENT_NOT_FOUND: 404,
	EVENT_ALREADY_WITHDRAWN: 409,
} as const satisfies RefusalStatuses<RecordEventRefusalCode>;
