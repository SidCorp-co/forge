"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { settingsApi } from "./api";

export function useTokens() {
  return useQuery({
    queryKey: ["settings", "tokens"],
    queryFn: settingsApi.listTokens,
  });
}

/** Create token. Returns the mutation so the caller can read `data.plaintext`
 *  for the one-time reveal and branch on the FRESH_AUTH_REQUIRED error code. */
export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.createToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "tokens"] }),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: settingsApi.revokeToken,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings", "tokens"] });
      toast({ title: t("settings.token.revoked"), tone: "success" });
    },
    onError: (err) => {
      toast({ title: t("settings.token.revokeFailed"), description: formatApiError(err), tone: "error" });
    },
  });
}

/** A token's project list, changed in place (FB-48). The caller branches on FRESH_AUTH_REQUIRED. */
export function useSetTokenProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.setTokenProjects,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "tokens"] }),
  });
}

export function useReauth() {
  return useMutation({ mutationFn: settingsApi.reauth });
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
  const t = useCopy();
  return useMutation({
    mutationFn: settingsApi.markAllRead,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["settings", "notifications"] });
      toast({ title: t("settings.notifications.markedRead", { n: res.updated }), tone: "success" });
    },
    onError: (err) => {
      toast({ title: t("settings.notifications.markReadFailed"), description: formatApiError(err), tone: "error" });
    },
  });
}

export function useAssistantPreferences() {
  return useQuery({
    queryKey: ["settings", "assistant-preferences"],
    queryFn: settingsApi.getAssistantPreferences,
  });
}

export function useUpdateAssistantPreferences() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: settingsApi.updateAssistantPreferences,
    onSuccess: (data) => {
      qc.setQueryData(["settings", "assistant-preferences"], data);
      void qc.invalidateQueries({ queryKey: ["settings", "preference-changes"] });
      toast({ title: t("settings.answers.saved"), tone: "success" });
    },
    onError: (err) => {
      toast({ title: t("settings.answers.saveFailed"), description: formatApiError(err), tone: "error" });
    },
  });
}

export function usePreferenceChanges() {
  return useQuery({
    queryKey: ["settings", "preference-changes"],
    queryFn: settingsApi.listPreferenceChanges,
  });
}

export function useRestorePreferenceChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.restorePreferenceChange,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings", "assistant-preferences"] });
      void qc.invalidateQueries({ queryKey: ["settings", "preference-changes"] });
    },
  });
}
