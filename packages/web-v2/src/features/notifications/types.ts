// web-v2 feature module: notifications (header bell). Mirrors the core
// `notifications` row serializer (GET /api/notifications returns raw rows).
// Workspace-global: the bell is NOT scoped to a single project.
import type { NotificationSeverity, NotificationType } from "@forge/contracts/notifications";

export type { NotificationSeverity, NotificationType };

export interface NotificationRow {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  // ISS-510 — explicit severity (drives bell hue + toast tone) and auto-resolve
  // linkage. Nullable: legacy rows created before ISS-510 carry none.
  severity: NotificationSeverity | null;
  resolutionKey: string | null;
  resolvedAt: string | null;
  issueId: string | null;
  // ISS-619 — the actionable issue when it differs from `issueId` (e.g. a
  // dependency-stall wedge's blocker/child). `issueId` stays the row's primary
  // subject for metric attribution; this drives a secondary deep-link action.
  secondaryIssueId: string | null;
  agentSessionId: string | null;
  createdAt: string;
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
