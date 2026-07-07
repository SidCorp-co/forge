// Maps a core NotificationRow onto the design `NotificationItem` shape the
// header bell renders. Keeps the presentation concerns (hue, short label,
// relative time) out of both the API layer and the layout.
import type { NotificationAction, NotificationItem } from "@/design";
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
    case "comment_added":
      return "COMMENT";
    case "agent_completed":
      return "AGENT";
    case "invitation_received":
      return "INVITE";
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

export function toNotificationItem(
  row: NotificationRow,
  actions?: NotificationAction[],
): NotificationItem {
  return {
    id: row.id,
    label: typeLabel(row.type),
    text: row.title,
    sub: row.body ?? undefined,
    time: formatRelativeTime(row.createdAt),
    unread: !row.read,
    hue: hueFor(row),
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
    text: `${inv.inviterEmail} invited you to ${inv.name} as ${inv.role}`,
    time: formatRelativeTime(inv.createdAt),
    unread: true,
    hue: "amber",
    actions,
  };
}
