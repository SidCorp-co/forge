import type { NotificationSeverity, NotificationType } from "@forge/contracts/notifications";

export type { NotificationSeverity, NotificationType };

export interface NotificationRow {
  id: string;
  notificationId: string;
  projectId: string | null;
  type: string;
  kind: string;
  tier: string;
  title: string;
  body: string | null;
  readAt: string | null;
  /** Non-null when this delivery groups several records under one cause. */
  groupKey: string | null;
  /** True when this delivery announces that a condition CLEARED. */
  resolvedNotice: boolean;
  /** How many records this delivery carries, and how many are still true. */
  members: number;
  openMembers: number;
  severity: NotificationSeverity | null;
  issueId: string | null;
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
