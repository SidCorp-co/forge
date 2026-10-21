"use client";

import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, NotificationsMenu, Popover } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useToast } from "@/providers/toast-provider";
import {
  useNotifications,
  useNotificationMembers,
  useOpenCount,
  useMarkRead,
  useMarkAllRead,
  usePendingInvitations,
  useAcceptInvitation,
  useDeclineInvitation,
} from "../hooks";
import { toNotificationItem, toInvitationItem } from "../map";
import { memberTexts, secondaryHref, subjectHref } from "../subject";
import type { PendingInvitation } from "../types";
import { type DeliveryNotification, useNotificationDelivery } from "../use-notification-delivery";
import { useOpenIndicator } from "../use-open-indicator";
import { failureToast } from "@/lib/api/failure-toast";

export interface NotificationsBellProps {
  /** Dropdown visibility — toggled by the TopBar bell button in the layout. */
  open: boolean;
  onClose: () => void;
  /** The bell button the dropdown is placed against. */
  anchor: RefObject<HTMLElement | null>;
}

export function NotificationsBell({ open, onClose, anchor }: NotificationsBellProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: projects } = useProjects();

  const notificationsQuery = useNotifications(open);
  const { data: openCount } = useOpenCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  // ISS-597 — pending invitations (Accept/Decline from the bell).
  const pendingQuery = usePendingInvitations(open);
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();
  const [declineTarget, setDeclineTarget] = useState<PendingInvitation | null>(null);

  const onAccept = useCallback(
    (inv: PendingInvitation) => {
      acceptInvitation.mutate(
        { kind: inv.kind, token: inv.token },
        {
          onSuccess: () =>
            toast({ title: `You joined ${inv.name} as ${inv.role}`, tone: "success" }),
          onError: (err) =>
            toast(failureToast(err, "The invitation was not accepted")),
        },
      );
    },
    [acceptInvitation, toast],
  );

  const onDeclineConfirm = useCallback(() => {
    if (!declineTarget) return;
    const inv = declineTarget;
    declineInvitation.mutate(
      { kind: inv.kind, token: inv.token },
      {
        onSuccess: () => {
          toast({ title: "Invitation declined", tone: "success" });
          setDeclineTarget(null);
        },
        onError: (err) => {
          toast(failureToast(err, "The invitation was not declined"));
          setDeclineTarget(null);
        },
      },
    );
  }, [declineTarget, declineInvitation, toast]);

  const notificationRows = useMemo(
    () => notificationsQuery.data?.items ?? [],
    [notificationsQuery.data],
  );

  // Actionable invite items prepended to the bell; passive invitation_received
  // rows are filtered out so each invite appears once (as the actionable item).
  // The badge counts the same: each pending invitation once, never its record (ISS-1229 r14).
  const pendingItems = useMemo(
    () =>
      (pendingQuery.data ?? []).map((inv) =>
        toInvitationItem(inv, [
          {
            id: "accept",
            label: "Accept",
            variant: "primary",
            loading: acceptInvitation.isPending && acceptInvitation.variables?.token === inv.token,
            disabled: acceptInvitation.isPending || declineInvitation.isPending,
            onClick: () => onAccept(inv),
          },
          {
            id: "decline",
            label: "Decline",
            variant: "ghost",
            loading: declineInvitation.isPending && declineInvitation.variables?.token === inv.token,
            disabled: acceptInvitation.isPending || declineInvitation.isPending,
            // The confirmation is a dialog in the page, and the dropdown sits in a
            // portal above the page, so the dropdown steps aside for it.
            onClick: () => {
              setDeclineTarget(inv);
              onClose();
            },
          },
        ]),
      ),
    [pendingQuery.data, acceptInvitation.isPending, acceptInvitation.variables, declineInvitation.isPending, declineInvitation.variables, onAccept, onClose],
  );

  // ISS-619 — a dependency-stall wedge's actionable target (the blocker/child
  // issue) can differ from `issueId` (the wedged issue, kept for interventions
  // metric attribution). Give those rows a distinct "Open sub-task" action
  // alongside the default row-click (which still deep-links `issueId`).
  const notificationItems = useMemo(
    () => [
      ...pendingItems,
      ...notificationRows
        .filter((r) => r.type !== "invitation_received")
        .map((row) => {
          if (row.type !== "pipeline_wedge" || !row.secondaryIssueId) return toNotificationItem(row);
          return toNotificationItem(row, [
            {
              id: "open-sub-task",
              label: "Open sub-task",
              variant: "primary",
              onClick: () => {
                markRead.mutate(row.id);
                onClose();
                const href = secondaryHref(row);
                if (href) router.push(href);
              },
            },
          ]);
        }),
    ],
    [pendingItems, notificationRows, markRead, router, onClose],
  );

  // ISS-1063 — a grouped delivery expands to the records it carries. The fetch is
  // deferred to the expansion so the common case (one member) costs no request, and
  // a member click deep-links the same way a plain row does.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const membersQuery = useNotificationMembers(expandedId);
  const expandedMembers = useMemo(() => {
    const members = membersQuery.data ?? [];
    const texts = memberTexts(members);
    return members.map((m, i) => ({
        id: m.id,
        text: texts[i] ?? m.title,
        sub: m.body ?? undefined,
        time: formatRelativeTime(m.deliveredAt),
    }));
  }, [membersQuery.data]);
  const onToggleGroup = useCallback(
    (id: string) => setExpandedId((prev) => (prev === id ? null : id)),
    [],
  );
  const onSelectMember = useCallback(
    (memberId: string) => {
      const member = membersQuery.data?.find((m) => m.id === memberId);
      const href = member ? subjectHref(member) : null;
      if (!href) return;
      if (expandedId) markRead.mutate(expandedId);
      onClose();
      router.push(href);
    },
    [membersQuery.data, expandedId, markRead, router, onClose],
  );
  // A row opens its subject and following it reads it. A grouped row has none of its own, since its
  // records are the subjects, so selecting it opens the group and reads nothing: a member followed
  // is what reads it, the same rule as the inbox.
  const onSelectNotification = useCallback(
    (id: string) => {
      const row = notificationRows.find((n) => n.id === id);
      if (!row) return;
      if (row.members > 1) {
        onToggleGroup(id);
        return;
      }
      if (row.readAt === null) markRead.mutate(id);
      onClose();
      const href = subjectHref(row);
      if (href) router.push(href);
    },
    [notificationRows, markRead, router, onClose, onToggleGroup],
  );

  // Realtime delivery bridge (ISS-510): toast + browser channels for incoming
  // `notification.created` events. Mounted here so a click reuses the same
  // mark-read + deep-link path as the bell. The persistent bell itself updates
  // via the event-router's query invalidation — independent of this hook.
  const onDeliveryNavigate = useCallback(
    (n: DeliveryNotification) => {
      markRead.mutate(n.notificationId);
      if (!n.projectId) return;
      const target = projects?.find((p) => p.id === n.projectId);
      if (!target) return;
      if (n.type === "reconcile_gate_pending") {
        router.push(`/projects/${target.slug}/library?tab=updates`);
        return;
      }
      if (!n.issueId) return;
      router.push(`/projects/${target.slug}/issues/${n.issueId}`);
    },
    [markRead, projects, router],
  );
  useNotificationDelivery(onDeliveryNavigate);

  // Always-visible indicator (ISS-523): mirror the OPEN count onto the favicon (a
  // dot) + document title (`(N) Forge`). Same source as the bell, so they never
  // disagree — and it covers the focused-tab case the background-only native
  // notification channel intentionally skips. ISS-1063: reading a notification no
  // longer changes this number; the thing being no longer true is what changes it.
  useOpenIndicator(openCount?.count ?? 0);

  // Esc closes the notifications dropdown (AC11 — always dismissable).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
          items={notificationItems}
          loading={notificationsQuery.isLoading || pendingQuery.isLoading}
          error={notificationsQuery.isError || pendingQuery.isError}
          errorWhy={
            notificationsQuery.isError
              ? formatApiError(notificationsQuery.error)
              : pendingQuery.isError
                ? formatApiError(pendingQuery.error)
                : undefined
          }
          onRetry={() => {
            notificationsQuery.refetch();
            pendingQuery.refetch();
          }}
          onSelect={onSelectNotification}
          onMarkAllRead={() => markAllRead.mutate()}
          expandedId={expandedId}
          expandedMembers={expandedMembers}
          expandedLoading={membersQuery.isLoading}
          onToggleGroup={onToggleGroup}
          onSelectMember={onSelectMember}
        />
      </Popover>

      {/* ISS-597 — decline confirmation modal */}
      <ConfirmDialog
        open={declineTarget !== null}
        title={`Decline invitation to ${declineTarget?.name ?? ""}?`}
        message={`You will no longer see this invitation in your notifications. You can still accept it via the original email link.`}
        confirmLabel="Yes, decline"
        tone="danger"
        loading={declineInvitation.isPending}
        onConfirm={onDeclineConfirm}
        onClose={() => setDeclineTarget(null)}
      />
    </>
  );
}
