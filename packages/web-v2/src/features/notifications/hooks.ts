"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invitationsApi, notificationsApi } from "./api";

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
