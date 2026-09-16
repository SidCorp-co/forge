"use client";

// cm:guard the keys MUST be exactly ["notifications"] and ["notifications-open"]: lib/ws/event-router.ts invalidates those on `notification.created` and `notification.read`, so keying them this way makes realtime free — and drift silently no-ops the realtime path with nothing red anywhere.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invitationsApi, notificationsApi } from "./api";

// cm:guard `enabled` gates the LIST, never `useOpenCount` below: the favicon and document-title indicator reads the count while the bell is closed, and the toast bridge reads the socket directly, so gating those two would take a surface away rather than a request (ISS-1019).
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsApi.list(),
    enabled,
  });
}

// cm:why ISS-1063 — this is a count of RECORDS still true, not of unread deliveries: opening the bell does not change it, and resolving one member of a grouped delivery lowers it by one. The old `useUnreadCount` is gone rather than renamed in place, so any caller still asking the old question fails to compile instead of quietly getting the new answer.
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
