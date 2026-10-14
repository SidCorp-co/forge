"use client";

// web-v2 feature module: settings — React Query hooks. User-scoped keys.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { settingsApi } from "./api";
import type { CreatePatInput } from "./types";

export function usePreferences() {
  return useQuery({
    queryKey: ["settings", "preferences"],
    queryFn: () => settingsApi.getPreferences(),
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (patch: Parameters<typeof settingsApi.updatePreferences>[0]) =>
      settingsApi.updatePreferences(patch),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "preferences"], data);
      toast({ title: "Preferences saved", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't save preferences", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useTokens() {
  return useQuery({
    queryKey: ["settings", "tokens"],
    queryFn: () => settingsApi.listTokens(),
  });
}

/** Create token. Returns the mutation so the caller can read `data.plaintext`
 *  for the one-time reveal and branch on the FRESH_AUTH_REQUIRED error code. */
export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePatInput) => settingsApi.createToken(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "tokens"] }),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => settingsApi.revokeToken(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "tokens"] });
      toast({ title: "Token revoked", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't revoke token", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useReauth() {
  return useMutation({ mutationFn: (password: string) => settingsApi.reauth(password) });
}

/**
 * The inbox as one list that grows by a page of 25 at a time. A row that moves from one page to the
 * next while the list is open (a newer notification pushes it down) is held once, where it first
 * appeared; the next page is asked for by how many rows the server has already sent, not how many
 * the list shows.
 */
export function useNotificationFeed() {
  return useInfiniteQuery({
    queryKey: ["settings", "notifications"],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => settingsApi.listNotifications(pageParam),
    getNextPageParam: (last, pages) => {
      const sent = pages.reduce((n, page) => n + page.items.length, 0);
      return last.items.length > 0 && sent < last.totalCount ? pages.length + 1 : undefined;
    },
    select: (data) => {
      const seen = new Set<string>();
      const rows = data.pages.flatMap((page) => page.items).filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
      return { rows, totalCount: data.pages[data.pages.length - 1]?.totalCount ?? 0 };
    },
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: () => settingsApi.markAllRead(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["settings", "notifications"] });
      toast({ title: `Marked ${res.updated} read`, tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useAssistantPreferences() {
  return useQuery({
    queryKey: ["settings", "assistant-preferences"],
    queryFn: () => settingsApi.getAssistantPreferences(),
  });
}

export function useUpdateAssistantPreferences() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (patch: Parameters<typeof settingsApi.updateAssistantPreferences>[0]) =>
      settingsApi.updateAssistantPreferences(patch),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "assistant-preferences"], data);
      qc.invalidateQueries({ queryKey: ["settings", "preference-changes"] });
      toast({ title: "Answer preferences saved", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't save answer preferences", description: formatApiError(err), tone: "error" });
    },
  });
}

export function usePreferenceChanges() {
  return useQuery({
    queryKey: ["settings", "preference-changes"],
    queryFn: () => settingsApi.listPreferenceChanges(),
  });
}

export function useRestorePreferenceChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => settingsApi.restorePreferenceChange(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "assistant-preferences"] });
      qc.invalidateQueries({ queryKey: ["settings", "preference-changes"] });
    },
  });
}
