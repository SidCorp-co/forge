// web-v2 feature module: notifications (header bell).
//
// ISS-1063 — a row here is a DELIVERY, not a record. `GET /api/notifications`
// returns one row per delivery with the record fields of its members folded in,
// so a grouped delivery is one bell row naming many records. `id` is the
// delivery's id — it is what `PATCH /api/notifications/:id` and
// `GET /api/notifications/:id/members` take. Read state lives here; whether the
// thing is still true lives on the record, which is what `openMembers` counts.
import type { NotificationSeverity, NotificationType } from "@forge/contracts/notifications";

export type { NotificationSeverity, NotificationType };

export interface NotificationRow {
  /** The DELIVERY id. Mark-read, done/dismiss and the member list all take it. */
  id: string;
  /** The first member record's id — what the realtime bridge deep-links by. */
  notificationId: string;
  projectId: string | null;
  type: string;
  kind: string;
  tier: string;
  title: string;
  body: string | null;
  /** When this person opened it. Null means unread; nothing else means unread. */
  readAt: string | null;
  /** Non-null when this delivery groups several records under one cause. */
  groupKey: string | null;
  /** True when this delivery announces that a condition CLEARED. */
  resolvedNotice: boolean;
  /** How many records this delivery carries, and how many are still true. */
  members: number;
  openMembers: number;
  // ISS-510 — explicit severity (drives bell hue + toast tone). Nullable:
  // legacy rows created before ISS-510 carry none.
  severity: NotificationSeverity | null;
  issueId: string | null;
  // ISS-619 — the actionable issue when it differs from `issueId` (e.g. a
  // dependency-stall wedge's blocker/child). `issueId` stays the row's primary
  // subject for metric attribution; this drives a secondary deep-link action.
  secondaryIssueId: string | null;
  agentSessionId: string | null;
  createdAt: string;
}

/** One record behind a delivery — `GET /api/notifications/:id/members`. */
export interface NotificationMember {
  id: string;
  type: string;
  kind: string;
  state: string;
  title: string;
  body: string | null;
  severity: NotificationSeverity | null;
  projectId: string | null;
  issueId: string | null;
  secondaryIssueId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** Still true for this reader: a firing condition or an unfinished task. */
  open: boolean;
}

// ISS-597 — pending invitation returned by GET /api/invitations/pending.
export interface PendingInvitation {
  kind: "project" | "org";
  token: string;
  name: string;
  inviterEmail: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}
