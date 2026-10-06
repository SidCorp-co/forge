import type { NotificationAction, NotificationGroupMember, NotificationItem } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { formatRelativeTime } from "@/lib/utils/format";
import type { NotificationMember, NotificationRow, PendingInvitation } from "./types";

/** One record a grouped delivery carries, as its expanded row reads (ISS-1063). */
export function toMemberItem(m: NotificationMember): NotificationGroupMember {
  return { id: m.id, text: m.title, time: formatRelativeTime(m.createdAt), open: m.open };
}

/** The bell hue a row's severity reads as. */
function hueFor(row: NotificationRow): NotificationItem["hue"] {
  switch (row.severity) {
    case "error":
      return "red";
    case "warning":
      return "amber";
    case "success":
      return "green";
    case "info":
      return "cobalt";
  }
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
    ...(row.subject ? { subjectKey: row.subject.key } : {}),
    ...(row.project && row.subject?.kind !== "project" ? { project: row.project.name } : {}),
    type: row.type,
    resolved: row.resolvedNotice || resolved,
    text: row.line,
    sub: liveBody(row),
    time: formatRelativeTime(row.createdAt),
    unread: row.readAt === null && !resolved,
    hue: resolved ? "green" : hueFor(row),
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
    id: `invite-${inv.ref}`,
    subjectKey: inv.name,
    type: "invitation_received",
    text: `${inv.inviterEmail} invited you as ${enumLabel("role", inv.role)}`,
    time: formatRelativeTime(inv.createdAt),
    unread: true,
    hue: "amber",
    actions,
  };
}
