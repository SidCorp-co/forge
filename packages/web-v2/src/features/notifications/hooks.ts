"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invitationsApi, notificationsApi } from "./api";
import { notificationKeys, notificationQueries } from "./queries";
import type { NotificationRow } from "./types";

/**
 * The bell's list: the open rows its badge counts. `remaining` is how many open rows core holds that
 * are not loaded yet, so the bell can offer them until none is left.
 */
export function useOpenNotifications(enabled = true) {
  const query = useInfiniteQuery(notificationQueries.open(enabled));
  const pages = query.data?.pages ?? [];
  // offset pages can repeat a row when a newer one opens between fetches; it is listed once
  const rows = [...new Map(pages.flatMap((p) => p.items).map((r): [string, NotificationRow] => [r.id, r])).values()];
  const total = pages.at(-1)?.totalCount ?? 0;
  return { query, rows, remaining: query.hasNextPage ? Math.max(0, total - rows.length) : 0 };
}

export const useOpenCount = () => useQuery(notificationQueries.openCount());
export const useNotificationMembers = (deliveryId: string | null) => useQuery(notificationQueries.members(deliveryId));
export const usePendingInvitations = (enabled = true) => useQuery(notificationQueries.invitations(enabled));

/** A read or an invitation answered moves the bell, its count and, for an invitation, the pending list. */
function useInvalidate(invitations = false) {
  const qc = useQueryClient();
  return () => {
    if (invitations) void qc.invalidateQueries({ queryKey: notificationKeys.invitations });
    void qc.invalidateQueries({ queryKey: notificationKeys.all });
    void qc.invalidateQueries({ queryKey: notificationKeys.openCount });
  };
}

export function useMarkRead() {
  return useMutation({ mutationFn: notificationsApi.markRead, onSuccess: useInvalidate() });
}

export function useMarkAllRead() {
  return useMutation({ mutationFn: () => notificationsApi.markAllRead(), onSuccess: useInvalidate() });
}

type InvitationRef = { kind: "project" | "org"; ref: string };

export function useAcceptInvitation() {
  return useMutation({ mutationFn: ({ kind, ref }: InvitationRef) => invitationsApi.accept(kind, ref), onSuccess: useInvalidate(true) });
}

export function useDeclineInvitation() {
  return useMutation({ mutationFn: ({ kind, ref }: InvitationRef) => invitationsApi.decline(kind, ref), onSuccess: useInvalidate(true) });
}
