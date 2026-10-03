import type { NotificationAction, NotificationItem } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { formatRelativeTime } from "@/lib/utils/format";
import type { NotificationRow, PendingInvitation } from "./types";

/** Short uppercase tag shown in the row's leading MonoTag. */
function typeLabel(type: string): string {
  switch (type) {
    case "issue_status_changed":
      return "STATUS";
    case "pipeline_wedge":
      return "WEDGE";
    case "mention":
      return "MENTION";
    case "invitation_received":
      return "INVITE";
    case "reconcile_gate_pending":
      return "SKILL";
    case "issue_stranded":
      return "STRANDED";
    case "retry_rescue_threshold":
      return "RETRY";
    case "channel_document_published":
      return "CHANNEL";
    case "channel_thread_held":
      return "HELD";
    case "channel_gate_pending":
      return "APPROVE";
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

/**
 * A delivery whose every record cleared — a condition resolved, a task done. It reads as resolved
 * rather than as still waiting: the "Resolved — …" notice beside it announces the change, and this
 * is the row that told of the thing in the first place.
 */
export function deliveryResolved(row: {
  kind: string;
  resolvedNotice: boolean;
  openMembers: number;
}): boolean {
  return !row.resolvedNotice && row.kind !== "signal" && row.openMembers === 0;
}

/**
 * The second line a row reads, or none once the row is resolved: the body was written while the
 * condition held, so a cleared delivery and its resolved notice drop it rather than say it still waits.
 */
export function liveBody(row: {
  kind: string;
  body: string | null;
  resolvedNotice: boolean;
  openMembers: number;
}): string | undefined {
  if (row.resolvedNotice || deliveryResolved(row)) return undefined;
  return row.body ?? undefined;
}

export function toNotificationItem(
  row: NotificationRow,
  actions?: NotificationAction[],
): NotificationItem {
  const resolved = deliveryResolved(row);
  return {
    id: row.id,
    label: row.resolvedNotice || resolved ? "RESOLVED" : typeLabel(row.type),
    text: row.title,
    sub: liveBody(row),
    time: formatRelativeTime(row.createdAt),
    unread: row.readAt === null && !resolved,
    hue: resolved ? "green" : hueFor(row),
    // A delivery carrying one record is a plain row; one carrying several names the
    // cause, says how many are still true, and expands to them.
    group: row.members > 1 ? { total: row.members, open: row.openMembers } : undefined,
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
    text: `${inv.inviterEmail} invited you to ${inv.name} as ${enumLabel("role", inv.role)}`,
    time: formatRelativeTime(inv.createdAt),
    unread: true,
    hue: "amber",
    actions,
  };
}
