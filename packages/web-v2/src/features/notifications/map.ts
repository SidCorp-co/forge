import type { NotificationAction, NotificationItem } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { NOTIFICATION_TYPES } from "@forge/contracts/notifications";
import { stuckTag } from "@forge/contracts/stuck-words";
import type { NotificationRow, NotificationType, PendingInvitation } from "./types";

/** What a type is called wherever a person picks or reads one. Every type has an entry, so a new
 *  type cannot reach the inbox's filter unnamed. */
export const TYPE_NAMES: Record<NotificationType, string> = {
  issue_status_changed: "Status changes",
  mention: "Mentions",
  pm_escalation: "Escalations",
  pipeline_wedge: "Pipeline stalls",
  invitation_received: "Invitations",
  intake_pending: "Intake review",
  schedule_report: "Schedule reports",
  reconcile_gate_pending: "Skill updates",
  issue_stranded: "Stuck issues",
  retry_rescue_threshold: "Retry rescues",
  ops_alert: "Operations",
};

/** The inbox's type filter: every type there is, in the order the contract lists them. */
export const TYPE_FILTER_OPTIONS: { value: NotificationType; label: string }[] =
  NOTIFICATION_TYPES.map((value) => ({ value, label: TYPE_NAMES[value] }));

/** Short uppercase tag shown in the row's leading MonoTag; a stuck row's is its kind's, or none. */
function typeLabel(row: Pick<NotificationRow, "type" | "stuckKind">): string | undefined {
  switch (row.type) {
    case "issue_status_changed":
      return "STATUS";
    case "pipeline_wedge":
      // A word a person reads, the filter's own name for the type (ISS-1228 round 19).
      return "STALLED";
    case "mention":
      return "MENTION";
    case "invitation_received":
      return "INVITE";
    case "reconcile_gate_pending":
      return "SKILL";
    case "issue_stranded":
      // Words its group's title says, never one none of them uses (ISS-1229 r15).
      return row.stuckKind ? (stuckTag(row.stuckKind) ?? undefined) : undefined;
    case "retry_rescue_threshold":
      return "RETRY";
    case "intake_pending":
      return "INTAKE";
    case "ops_alert":
      return "OPS";
    default:
      return "EVENT";
  }
}

/** Red for trouble, amber for review gates, green for done, cobalt otherwise. */
function hueFor(row: NotificationRow): NotificationItem["hue"] {
  // ISS-510 — derive from the explicit contract severity when present.
  switch (row.severity) {
    case "error":
      return "red";
    case "warning":
      return "amber";
    case "success":
      return "green";
    case "info":
      return "cobalt";
    default:
      break;
  }
  // Fallback for legacy rows (pre-ISS-510) with no severity: sniff title/type.
  const t = `${row.title} ${row.type}`.toLowerCase();
  if (row.type === "pipeline_wedge" || t.includes("reopen") || t.includes("fail")) return "red";
  if (t.includes("tested") || t.includes("waiting") || t.includes("review")) return "amber";
  if (t.includes("closed") || t.includes("released") || t.includes("complete")) return "green";
  return "cobalt";
}

/** A condition none of whose records still holds: the row that raised it is history, beside the row that says it resolved. */
function clearedCondition(row: NotificationRow): boolean {
  return !row.resolvedNotice && row.kind === "condition" && row.members > 0 && row.openMembers === 0;
}

/** What the row says under its title: a cleared condition says so first, and what it said then after it. */
function subOf(row: NotificationRow): string | undefined {
  if (!clearedCondition(row)) return row.body ?? undefined;
  return row.body ? `Since resolved. When it was raised: ${row.body}` : "Since resolved.";
}

function groupOf(row: NotificationRow, cleared: boolean): NotificationItem["group"] {
  if (row.members <= 1 || cleared) return undefined;
  if (row.kind === "signal") return { count: row.members, open: false };
  return row.openMembers > 0 ? { count: row.openMembers, open: true } : undefined;
}

export function toNotificationItem(
  row: NotificationRow,
  actions?: NotificationAction[],
): NotificationItem {
  const cleared = clearedCondition(row);
  return {
    id: row.id,
    label: row.resolvedNotice || cleared ? "RESOLVED" : typeLabel(row),
    text: row.title,
    sub: subOf(row),
    time: formatRelativeTime(row.toldAt),
    // The server says whether anything is left to read: a resolved row is history, read or not.
    unread: row.unread,
    hue: cleared ? "green" : hueFor(row),
    // A delivery carrying one record is a plain row; one carrying several names the cause, says how
    // many are still true, and expands to those alone: a resolved record leaves the group (ISS-1229 r16).
    group: groupOf(row, cleared),
    actions,
  };
}

// ISS-597 — builds the actionable invite item for the bell. Actions are
// provided by the layout (which owns the mutation callbacks).
export function toInvitationItem(
  inv: PendingInvitation,
  actions: NotificationItem["actions"],
): NotificationItem {
  return {
    id: `invite-${inv.token}`,
    label: "INVITE",
    text: `${inv.inviterName} invited you to ${inv.name} as ${inv.role}`,
    time: formatRelativeTime(inv.createdAt),
    unread: true,
    hue: "amber",
    actions,
  };
}
