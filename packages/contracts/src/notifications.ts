export const NOTIFICATION_TYPES = [
	"issue_status_changed",
	"mention",
	"pipeline_wedge",
	"invitation_received",
	"intake_pending",
	"schedule_report",
	"issue_stranded",
	"retry_rescue_threshold",
	"ops_alert",
	"channel_document_published",
	"channel_thread_held",
	"channel_gate_pending",
	"contract_version_published",
	"requirement_delivered",
	"feedback_verify_asked",
	"feedback_shipped",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** What the bell's badge reads for each type: sentence case, the raw value only in its tooltip. */
export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
	issue_status_changed: "Status change",
	mention: "Mention",
	pipeline_wedge: "Pipeline stuck",
	invitation_received: "Invitation",
	intake_pending: "Intake",
	schedule_report: "Schedule report",
	issue_stranded: "Stranded",
	retry_rescue_threshold: "Retries",
	ops_alert: "Ops alert",
	channel_document_published: "Channel document",
	channel_thread_held: "Thread held",
	channel_gate_pending: "Approval",
	contract_version_published: "Contract version",
	requirement_delivered: "Delivered",
	feedback_verify_asked: "Verify the fix",
	feedback_shipped: "Shipped",
};

/** What a delivery names, read from the record's references by core, never from its text. */
const NOTIFICATION_SUBJECT_KINDS = ["issue", "project"] as const;
export type NotificationSubjectKind =
	(typeof NOTIFICATION_SUBJECT_KINDS)[number];

export interface NotificationSubject {
	kind: NotificationSubjectKind;
	/** `ISS-12` for an issue, the project's slug for a project. */
	key: string;
	id: string;
}

const NOTIFICATION_KINDS = ["signal", "condition", "task"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const NOTIFICATION_TIERS = ["page", "ticket", "log"] as const;
export type NotificationTier = (typeof NOTIFICATION_TIERS)[number];

export type NotificationSeverity = "info" | "success" | "warning" | "error";
type NotificationChannel = "bell" | "toast" | "browser";

export interface NotificationTypeContract {
	/** Default severity; an emitter MAY override per-event (e.g.
	 *  `issue_status_changed` derives severity from the `to` status). */
	severity: NotificationSeverity;
	/** Surfaces this type targets. `bell` is implied for every persisted type. */
	channels: NotificationChannel[];
	/** ISS-1063 — the record kind, declared ONCE. A type that is sometimes an event and
	 *  sometimes a condition is the defect this field closes: 1771 `issue_status_changed`
	 *  rows carried a condition's resolution key while the type is an event. */
	kind: NotificationKind;
	/** ISS-1063 — urgency, not routing. `channels` still decides which surfaces it reaches. */
	tier: NotificationTier;
	/** Prometheus's `for`, counted in evaluations of a PERIODIC detector. */
	pendingEvaluations?: number;
}

/**
 * The channel matrix (ISS-510). Browser is reserved for high-signal types so
 * the OS surface stays quiet; everything is still recorded in the bell.
 */
const NOTIFICATION_CONTRACT: Record<
	NotificationType,
	NotificationTypeContract
> = {
	issue_status_changed: {
		severity: "info",
		channels: ["bell", "toast"],
		kind: "signal",
		tier: "log",
	},
	mention: {
		severity: "info",
		channels: ["bell", "toast", "browser"],
		kind: "signal",
		tier: "ticket",
	},
	pipeline_wedge: {
		severity: "error",
		channels: ["bell", "toast", "browser"],
		kind: "condition",
		tier: "page",
	},
	invitation_received: {
		severity: "warning",
		channels: ["bell", "toast"],
		kind: "task",
		tier: "ticket",
	},
	intake_pending: {
		severity: "info",
		channels: ["bell", "toast"],
		kind: "task",
		tier: "ticket",
	},
	schedule_report: {
		severity: "info",
		channels: ["bell", "toast"],
		kind: "signal",
		tier: "log",
	},
	issue_stranded: {
		severity: "warning",
		channels: ["bell", "toast", "browser"],
		kind: "condition",
		tier: "ticket",
		pendingEvaluations: 2,
	},
	retry_rescue_threshold: {
		severity: "warning",
		channels: ["bell", "toast", "browser"],
		kind: "condition",
		tier: "ticket",
		pendingEvaluations: 2,
	},
	ops_alert: {
		severity: "warning",
		channels: ["bell", "toast"],
		kind: "condition",
		tier: "ticket",
	},
	channel_document_published: {
		severity: "info",
		channels: ["bell", "toast"],
		kind: "signal",
		tier: "ticket",
	},
	channel_thread_held: {
		severity: "warning",
		channels: ["bell", "toast"],
		kind: "condition",
		tier: "ticket",
	},
	channel_gate_pending: {
		severity: "warning",
		channels: ["bell", "toast", "browser"],
		kind: "task",
		tier: "ticket",
	},
	contract_version_published: {
		severity: "info",
		channels: ["bell"],
		kind: "signal",
		tier: "log",
	},
	requirement_delivered: {
		severity: "info",
		channels: ["bell", "toast"],
		kind: "task",
		tier: "ticket",
	},
	feedback_verify_asked: {
		severity: "info",
		channels: ["bell", "toast"],
		kind: "task",
		tier: "ticket",
	},
	feedback_shipped: {
		severity: "success",
		channels: ["bell", "toast"],
		kind: "signal",
		tier: "log",
	},
};

/** A type's kind, tier, default severity and channels: the one declaration core and web both read. */
export function notificationContractOf(
	type: NotificationType,
): NotificationTypeContract {
	return NOTIFICATION_CONTRACT[type];
}

/** Channels a type targets; defaults to bell-only for an unknown/legacy type. */
export function channelsFor(type: string): NotificationChannel[] {
	return NOTIFICATION_CONTRACT[type as NotificationType]?.channels ?? ["bell"];
}

export const NOTIFICATION_REFUSAL_CODES = [
	"NOTIFICATION_REFUSED",
	"CONDITION_STILL_TRUE",
] as const;
export type NotificationRefusalCode =
	(typeof NOTIFICATION_REFUSAL_CODES)[number];

/** The resolution key of an issue's stranded condition: raised by the pipeline sweep, resolved by any move but to needs_info. */
export function strandedResolutionKey(issueId: string): string {
	return `issue:${issueId}:stranded`;
}

/** The resolution key of an issue's owed-close condition, resolved once the issue reaches a terminal status. */
export function owedCloseResolutionKey(issueId: string): string {
	return `issue:${issueId}:owed-close`;
}

/** The dedupe key of the notice that a shipped release told one feedback item's reporter, once per item and release. */
export function feedbackShippedKey(feedbackId: string, runId: string): string {
	return `feedback-shipped:${feedbackId}:${runId}`;
}

/** The prefix every such notice of one item shares: what the feedback page reads "Reporter told" from. */
export function feedbackShippedPrefix(feedbackId: string): string {
	return `feedback-shipped:${feedbackId}:`;
}
