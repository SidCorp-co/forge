"use client";

// Header notification bell cluster (ISS-504 / ISS-597 / ISS-510 / ISS-523).
// Owns everything behind the TopBar bell: the dropdown (+ click-away + Esc),
// the notification/invitation queries, accept/decline mutations with the
// decline ConfirmDialog, row → item mapping, and the always-mounted realtime
// delivery + unread-indicator bridges. The layout only owns the `open` state
// (the TopBar bell button toggles it) and passes it down — so this component
// must stay MOUNTED even while closed, or the delivery/indicator hooks stop.
// Rendered inside the layout's `relative` TopBar wrapper (the dropdown is
// absolutely positioned against it).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { NotificationsMenu } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { ConfirmDialog } from "@/features/orgs/components/confirm-dialog";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import {
  useNotifications,
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
  usePendingInvitations,
  useAcceptInvitation,
  useDeclineInvitation,
} from "../hooks";
import { toNotificationItem, toInvitationItem } from "../map";
import type { PendingInvitation } from "../types";
import { type DeliveryNotification, useNotificationDelivery } from "../use-notification-delivery";
import { useUnreadIndicator } from "../use-unread-indicator";

export interface NotificationsBellProps {
  /** Dropdown visibility — toggled by the TopBar bell button in the layout. */
  open: boolean;
  onClose: () => void;
}

export function NotificationsBell({ open, onClose }: NotificationsBellProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: projects } = useProjects();

  // Header notification bell (ISS-504). Workspace-global: list + unread count
  // are scoped to the current user server-side. Realtime is free — the WS
  // event-router invalidates these exact query keys on notification.created.
  const notificationsQuery = useNotifications();
  const { data: unread } = useUnreadCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  // ISS-597 — pending invitations (Accept/Decline from the bell).
  const pendingQuery = usePendingInvitations();
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
            toast({ title: "Failed to accept invitation", description: formatApiError(err), tone: "error" }),
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
          toast({ title: "Failed to decline invitation", description: formatApiError(err), tone: "error" });
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
  // The passive rows still count toward the unread badge via the unread-count API.
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
            onClick: () => setDeclineTarget(inv),
          },
        ]),
      ),
    [pendingQuery.data, acceptInvitation.isPending, acceptInvitation.variables, declineInvitation.isPending, declineInvitation.variables, onAccept],
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
                const target = projects?.find((p) => p.id === row.projectId);
                if (target) router.push(`/projects/${target.slug}/issues/${row.secondaryIssueId}`);
              },
            },
          ]);
        }),
    ],
    [pendingItems, notificationRows, markRead, projects, router, onClose],
  );
  const onSelectNotification = useCallback(
    (id: string) => {
      const row = notificationRows.find((n) => n.id === id);
      if (row && !row.read) markRead.mutate(id);
      onClose();
      if (!row?.issueId || !row.projectId) return; // mark-read only, no dead-end
      const target = projects?.find((p) => p.id === row.projectId);
      if (target) router.push(`/projects/${target.slug}/issues/${row.issueId}`);
    },
    [notificationRows, markRead, projects, router, onClose],
  );

  // Realtime delivery bridge (ISS-510): toast + browser channels for incoming
  // `notification.created` events. Mounted here so a click reuses the same
  // mark-read + deep-link path as the bell. The persistent bell itself updates
  // via the event-router's query invalidation — independent of this hook.
  const onDeliveryNavigate = useCallback(
    (n: DeliveryNotification) => {
      markRead.mutate(n.notificationId);
      if (!n.issueId || !n.projectId) return;
      const target = projects?.find((p) => p.id === n.projectId);
      if (target) router.push(`/projects/${target.slug}/issues/${n.issueId}`);
    },
    [markRead, projects, router],
  );
  useNotificationDelivery(onDeliveryNavigate);

  // Always-visible unread indicator (ISS-523): mirror the unread count onto the
  // favicon (a dot) + document title (`(N) Forge`). Same source as the bell, so
  // they never disagree — and it covers the focused-tab case the background-only
  // native notification channel intentionally skips.
  useUnreadIndicator(unread?.count ?? 0);

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
      {open && (
        <>
          {/* click-away catcher */}
          <button
            type="button"
            aria-label="Close notifications"
            className="fixed inset-0 z-40 cursor-default"
            onClick={onClose}
          />
          <div className="absolute right-4 top-[52px] z-50">
            <NotificationsMenu
              items={notificationItems}
              loading={notificationsQuery.isLoading || pendingQuery.isLoading}
              error={notificationsQuery.isError || pendingQuery.isError}
              onRetry={() => {
                notificationsQuery.refetch();
                pendingQuery.refetch();
              }}
              onSelect={onSelectNotification}
              onMarkAllRead={() => markAllRead.mutate()}
            />
          </div>
        </>
      )}

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
