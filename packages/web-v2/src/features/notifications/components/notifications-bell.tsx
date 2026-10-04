"use client";

import { type RefObject, useState } from "react";
import { useRouter } from "next/navigation";
import { NotificationsMenu, Popover } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { useMarkAllRead, useMarkRead, useNotificationMembers, useNotifications, useOpenCount } from "../hooks";
import { toMemberItem, toNotificationItem } from "../map";
import { useNotificationDelivery } from "../use-notification-delivery";
import type { NotificationRow } from "../types";
import { useOpenIndicator } from "../use-open-indicator";
import { useInvitationItems } from "./use-invitation-items";

export interface NotificationsBellProps {
  /** Dropdown visibility — toggled by the sidebar bell, or the bell in the mobile More drawer. */
  open: boolean;
  onClose: () => void;
  /** The bell button the dropdown is placed against. */
  anchor: RefObject<HTMLElement | null>;
}

/**
 * The bell's own rows. A passive invitation_received row is dropped: the invite shows once, as its
 * actionable item, and still counts toward the badge through the open count. ISS-619: a
 * dependency-stall wedge also offers its blocker, which differs from the wedged issue.
 */
function bellItems(rows: NotificationRow[], openSubTask: (row: NotificationRow) => void) {
  return rows
    .filter((r) => r.type !== "invitation_received")
    .map((row) =>
      row.type === "pipeline_wedge" && row.secondaryIssueId
        ? toNotificationItem(row, [
            { id: "open-sub-task", label: "Open sub-task", variant: "primary", onClick: () => openSubTask(row) },
          ])
        : toNotificationItem(row),
    );
}

export function NotificationsBell({ open, onClose, anchor }: NotificationsBellProps) {
  const router = useRouter();
  const { data: projects } = useProjects();
  const notificationsQuery = useNotifications(open);
  const { data: openCount } = useOpenCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const invitations = useInvitationItems(open, onClose);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // ISS-1063: a grouped delivery fetches its records only once expanded.
  const membersQuery = useNotificationMembers(expandedId);

  /** Every click on a notification ends here: to the issue it names, in the project it sits in. */
  const openIssue = (projectId: string | null | undefined, issueId: string | null | undefined) => {
    const slug = projects?.find((p) => p.id === projectId)?.slug;
    if (slug && issueId) router.push(`/projects/${slug}/issues/${issueId}`);
  };

  const rows = notificationsQuery.data?.items ?? [];
  const items = [
    ...invitations.items,
    ...bellItems(rows, (row) => {
      markRead.mutate(row.id);
      onClose();
      openIssue(row.projectId, row.secondaryIssueId);
    }),
  ];

  // ISS-510: toasts and browser notifications for live deliveries reuse the bell's mark-read + deep link.
  useNotificationDelivery((n) => {
    markRead.mutate(n.notificationId);
    openIssue(n.projectId, n.issueId);
  });
  // ISS-523: the open count on the favicon and the title, from the same source as the bell.
  useOpenIndicator(openCount?.count ?? 0);

  return (
    <>
      <Popover
        open={open}
        anchor={anchor}
        onDismiss={onClose}
        placement="bottom-end"
        gap={8}
        lockScroll
        takesFocus
        aria-label="Notifications"
        className="overflow-y-auto"
      >
        <NotificationsMenu
          items={items}
          loading={notificationsQuery.isLoading || invitations.query.isLoading}
          error={notificationsQuery.isError || invitations.query.isError}
          onRetry={() => {
            notificationsQuery.refetch();
            invitations.query.refetch();
          }}
          onSelect={(id) => {
            const row = rows.find((n) => n.id === id);
            if (row?.readAt === null) markRead.mutate(id);
            onClose();
            openIssue(row?.projectId, row?.issueId);
          }}
          onMarkAllRead={() => markAllRead.mutate()}
          expandedId={expandedId}
          expandedMembers={(membersQuery.data ?? []).map(toMemberItem)}
          expandedLoading={membersQuery.isLoading}
          onToggleGroup={(id) => setExpandedId((prev) => (prev === id ? null : id))}
          onSelectMember={(memberId) => {
            const member = membersQuery.data?.find((m) => m.id === memberId);
            if (!member?.projectId || !member.issueId || !projects?.some((p) => p.id === member.projectId)) return;
            onClose();
            openIssue(member.projectId, member.issueId);
          }}
        />
      </Popover>
      {invitations.dialog}
    </>
  );
}
