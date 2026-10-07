"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invitationsApi, notificationsApi } from "./api";
import type { NotificationRow } from "./types";

/**
 * The bell's list: the open rows its badge counts, a page at a time (ISS-289). `remaining` is how
 * many open rows core holds that are not loaded yet, so the bell can offer them until none is left.
 */
export function useOpenNotifications(enabled = true) {
  const query = useInfiniteQuery({
    queryKey: ["notifications", "open"],
    queryFn: ({ pageParam }) => notificationsApi.openPage(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.totalCount ? pages.length + 1 : undefined;
    },
    enabled,
  });
  const pages = query.data?.pages ?? [];
  // offset pages can repeat a row when a newer one opens between fetches; it is listed once
  const seen = new Set<string>();
  const rows: NotificationRow[] = [];
  for (const row of pages.flatMap((p) => p.items)) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  const total = pages.at(-1)?.totalCount ?? 0;
  return { query, rows, remaining: query.hasNextPage ? Math.max(0, total - rows.length) : 0 };
}

export function useOpenCount() {
  return useQuery({
    queryKey: ["notifications-open"],
    queryFn: () => notificationsApi.openCount(),
  });
}

/** The records behind one delivery — fetched only when the reader expands it. */
export function useNotificationMembers(deliveryId: string | null) {
  return useQuery({
    queryKey: ["notifications", "members", deliveryId],
    queryFn: () => notificationsApi.members(deliveryId as string),
    enabled: deliveryId !== null,
  });
}

function useInvalidateNotifications() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["notifications-open"] });
  };
}

export function useMarkRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: notificationsApi.markRead,
    onSuccess: invalidate,
  });
}

export function useMarkAllRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: invalidate,
  });
}

// ISS-597 — pending invitations hooks.

export function usePendingInvitations(enabled = true) {
  return useQuery({
    queryKey: ["invitations-pending"],
    queryFn: () => invitationsApi.pending(),
    enabled,
  });
}

function useInvalidateInvitations() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["invitations-pending"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["notifications-open"] });
  };
}

export function useAcceptInvitation() {
  const invalidate = useInvalidateInvitations();
  return useMutation({
    mutationFn: ({ kind, ref }: { kind: "project" | "org"; ref: string }) =>
      invitationsApi.accept(kind, ref),
    onSuccess: invalidate,
  });
}

export function useDeclineInvitation() {
  const invalidate = useInvalidateInvitations();
  return useMutation({
    mutationFn: ({ kind, ref }: { kind: "project" | "org"; ref: string }) =>
      invitationsApi.decline(kind, ref),
    onSuccess: invalidate,
  });
}
