"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shouldRetryQuery } from "@/providers/query-provider";
import { type InboxFilter, invitationsApi, notificationsApi } from "./api";

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsApi.list(),
    enabled,
  });
}

export function useOpenCount() {
  return useQuery({
    queryKey: ["notifications-open"],
    queryFn: () => notificationsApi.openCount(),
  });
}

/**
 * The inbox as one list that grows by a page of 25 at a time, narrowed by `filter` on the server.
 * A row that moves from one page to the next while the list is open (a newer notification pushes
 * it down) is held once, where it first appeared; the next page is asked for by how many rows the
 * server has already sent, not how many the list shows.
 *
 * Once rows are on screen a failed ask is answered with the Retry beside them, so it is asked once
 * and the person decides about the next ask: the query client's own retries would ask three times,
 * behind a "Loading more…" that says nothing of them. The first load has no Retry yet, so it keeps
 * the client's policy. The key sits under `["notifications"]`, so a `notification.created` event
 * refreshes the inbox as it does the bell.
 */
export function useNotificationInbox(filter: InboxFilter) {
  const qc = useQueryClient();
  const key = ["notifications", "inbox", filter.type, filter.unreadOnly] as const;
  return useInfiniteQuery({
    queryKey: key,
    retry: (failureCount, error) =>
      qc.getQueryData(key) === undefined && shouldRetryQuery(failureCount, error),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => notificationsApi.inbox(pageParam, filter),
    getNextPageParam: (last, pages) => {
      const sent = pages.reduce((n, page) => n + page.items.length, 0);
      return last.items.length > 0 && sent < last.totalCount ? pages.length + 1 : undefined;
    },
    select: (data) => {
      const seen = new Set<string>();
      const rows = data.pages
        .flatMap((page) => page.items)
        .filter((row) => {
          if (seen.has(row.id)) return false;
          seen.add(row.id);
          return true;
        });
      return { rows, totalCount: data.pages[data.pages.length - 1]?.totalCount ?? 0 };
    },
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
    mutationFn: (id: string) => notificationsApi.markRead(id),
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
    mutationFn: ({ kind, token }: { kind: "project" | "org"; token: string }) =>
      invitationsApi.accept(kind, token),
    onSuccess: invalidate,
  });
}

export function useDeclineInvitation() {
  const invalidate = useInvalidateInvitations();
  return useMutation({
    mutationFn: ({ kind, token }: { kind: "project" | "org"; token: string }) =>
      invitationsApi.decline(kind, token),
    onSuccess: invalidate,
  });
}
