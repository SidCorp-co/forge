// The comment-intent and record-event vocabulary (ISS-56): one declaration, read by core (its
// writes and `activity_log_record_kind_chk`) and by the browser.

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
type KernelRecordKind = (typeof KERNEL_RECORD_KINDS)[number];

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

export const RECORD_EVENT_REFUSAL_CODES = [
	"EVENT_REFUSED",
	"EVENT_KIND_UNKNOWN",
	"EVENT_KIND_KERNEL_ONLY",
	"EVENT_PAYLOAD_INVALID",
	"KERNEL_RECORD_IMMUTABLE",
] as const;
export type RecordEventRefusalCode = (typeof RECORD_EVENT_REFUSAL_CODES)[number];
