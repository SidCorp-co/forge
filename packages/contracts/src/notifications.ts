// Canonical notification taxonomy + per-type delivery contract (ISS-510).
//
// One source of truth shared by core emission and web-v2 rendering: every
// notification type declares its default `severity` and which of the three
// surfaces it targets —
//   • `bell`    — persistent in-app notification center (always on)
//   • `toast`   — transient on-screen toast/snackbar
//   • `browser` — native OS / Chrome notification (permission + opt-in gated)
//
// Core's `emitNotification` reads `defaultSeverityForType`; web-v2's realtime
// delivery bridge reads `channelsFor` to decide whether an incoming
// `notification.created` event pops a toast and/or a browser notification.

// cm:why ISS-1063 removed `comment_added` and `agent_completed`. Neither had an emitter
// ANYWHERE — the strings appeared only in this list and in core's column — and neither had
// ever produced a row in the 11037 on the production replica. `mention` and
// `retry_rescue_threshold` read the same in that table (zero rows) and were KEPT, because
// both have live wired emitters whose trigger has simply not occurred: `notify-mentions.ts`
// registered in `eager-subscribers.ts`, and `retry-rescue-alert.ts` as a sweeper pass. A type
// declared and never emitted is the defect; a type whose condition has not happened is not.
export const NOTIFICATION_TYPES = [
	"issue_status_changed",
	"mention",
	"pm_escalation",
	"pipeline_wedge",
	"invitation_received",
	"intake_pending",
	"schedule_report",
	"reconcile_gate_pending",
	"issue_stranded",
	"retry_rescue_threshold",
	"ops_alert",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * What KIND of record a type is, which is the thing one table was carrying three of
 * (ISS-1063). The kind decides the lifecycle, and the lifecycle decides whether the
 * record can appear in a count of what is still open.
 *
 * - `signal`    — something happened. Immutable, no resolution key, no resolved
 *   timestamp, expires by retention. NEVER counted as open, because an event cannot
 *   stop having happened. 3914 of the 5663 rows the owner read as "open" were this.
 * - `condition` — something is true and still is. `pending → firing → resolved`, and it
 *   is resolved by the system re-evaluating it, never by a person marking it.
 * - `task`      — something needs a person. `open → acknowledged → done | dismissed`. It
 *   does not self-clear; it closes when the work is done.
 */
export const NOTIFICATION_KINDS = ["signal", "condition", "task"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * How urgent a record is, which is a different question from which channel carries it.
 * Google SRE's page / ticket / log tiering: `page` must be handled now, `ticket` should
 * be done but is not urgent, `log` belongs on a dashboard and not in anybody's inbox.
 *
 * This is a CLASSIFICATION and not a rota, and it is not a routing table either — the
 * channel matrix below still decides which surfaces a type reaches, and ISS-1063 changes
 * none of those values.
 */
export const NOTIFICATION_TIERS = ["page", "ticket", "log"] as const;
export type NotificationTier = (typeof NOTIFICATION_TIERS)[number];

export type NotificationSeverity = "info" | "success" | "warning" | "error";
export type NotificationChannel = "bell" | "toast" | "browser";

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
	/**
	 * ISS-1063 — how many evaluations of a PERIODIC detector a condition must survive
	 * before anybody is told, borrowed from Prometheus's `for`. `0` or absent means fire
	 * on the first evaluation, which is the only honest answer for a type whose producer
	 * is event-driven: there is no second evaluation coming, so waiting for one would
	 * delay the alarm forever. Meaningless on a `signal` or a `task`.
	 */
	pendingEvaluations?: number;
}

/**
 * The channel matrix (ISS-510). Browser is reserved for high-signal types so
 * the OS surface stays quiet; everything is still recorded in the bell.
 */
export const NOTIFICATION_CONTRACT: Record<
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
	pm_escalation: {
		severity: "warning",
		channels: ["bell", "toast", "browser"],
		kind: "task",
		tier: "page",
	},
	// cm:why no pending duration — every `pipeline_wedge` producer is event-driven (`jobs/hold.ts`, `jobs/retry.ts`, the runner fault paths, the loop monitor's miss handlers), so there is no second evaluation to wait for and a `for` here would hold the alarm until something re-emitted it, which nothing would
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
	reconcile_gate_pending: {
		severity: "warning",
		channels: ["bell", "toast"],
		kind: "task",
		tier: "ticket",
	},
	// cm:why ISS-762 — browser-channel because this one is defined by nobody looking: the three known cases sat 7–12 days precisely because a bell nobody opened was the only surface. A type that fires only when a human already stopped watching has to reach past the app.
	// cm:why ISS-1063 gives this a pending duration of 2 and nothing else has one: its producer is `detectStrandedIssues`, a sweeper pass that re-derives the predicate every 60s, so a second evaluation is guaranteed to come. Google SRE asks a condition to hold "at least two rule evaluation cycles" before it is reported, and a park that clears within two sweeps was never worth telling anybody about.
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
	// cm:why ISS-652 — browser channel deliberately omitted: an ops alert is checked by someone already watching the console, unlike issue_stranded (defined by nobody looking)
	// cm:why ISS-1063 records this at `ticket` and NOT `page`, though the model document attached to that issue maps it to page. The owner was offered exactly that — keep ops_alert on AND raise it to a page tier while everything else is silent — and did not take it, so the taxonomy records the urgency this type has today rather than the one the document proposed. Its channels are untouched for the same reason.
	ops_alert: {
		severity: "warning",
		channels: ["bell", "toast"],
		kind: "condition",
		tier: "ticket",
	},
};

/**
 * ISS-1063 — which firing record suppresses which, so a root cause is reported once
 * instead of once per affected child.
 *
 * Alertmanager's `inhibit_rules`. A `target` condition emitted while a `source` record is
 * firing on the same `scope` is written inhibited and delivered to nobody; when the source
 * resolves the child is returned to `pending` rather than delivered, so a child that
 * cleared while it was suppressed tells nobody about something already false.
 */
export interface NotificationInhibitRule {
	/** The firing type that suppresses. */
	source: NotificationType;
	/** The type that is suppressed while it does. */
	target: NotificationType;
	/**
	 * What the two must share for the rule to apply. `project` is the only scope this
	 * change needs: a wedge naming a project's runner pool suppresses that project's
	 * stranded parks, because the parks are what the wedge is causing.
	 */
	scope: "project";
}

export const INHIBIT_RULES: readonly NotificationInhibitRule[] = [
	// cm:why the 11:21 burst on 2026-09-16 is this rule's acceptance case: 15 distinct `issue_stranded` conditions were raised in one sweep across 7 projects, 88 rows over 7 users, and the cause was one thing — a master that had stopped claiming. The wedge that names the runner pool is the root, and every park behind it is a child of it, not a problem of its own.
	{ source: "pipeline_wedge", target: "issue_stranded", scope: "project" },
];

/** Channels a type targets; defaults to bell-only for an unknown/legacy type. */
export function channelsFor(type: string): NotificationChannel[] {
	return NOTIFICATION_CONTRACT[type as NotificationType]?.channels ?? ["bell"];
}

/** Contract default severity; `info` for an unknown/legacy type. */
export function defaultSeverityForType(type: string): NotificationSeverity {
	return NOTIFICATION_CONTRACT[type as NotificationType]?.severity ?? "info";
}

/** Whether a type targets a given delivery channel. */
export function targetsChannel(
	type: string,
	channel: NotificationChannel,
): boolean {
	return channelsFor(type).includes(channel);
}
