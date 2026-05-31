"use client";

// web-v2 feature module: settings — React Query hooks. User-scoped keys.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { settingsApi } from "./api";
import type { CreatePatInput, Preferences } from "./types";

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
    mutationFn: (patch: Partial<Pick<Preferences, "theme" | "language">>) =>
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

export function useNotifications(page: number) {
  return useQuery({
    queryKey: ["settings", "notifications", page],
    queryFn: () => settingsApi.listNotifications(page),
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
