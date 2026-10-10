"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useCopy } from "@/lib/i18n/interface-language";
import { preferencesApi } from "./api";

/** The key the realtime router invalidates on `user.preferencesChanged`. */
export const PREFERENCES_KEY = ["settings", "preferences"] as const;

export function usePreferences() {
  return useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: preferencesApi.get,
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: preferencesApi.update,
    onSuccess: (data) => {
      qc.setQueryData(PREFERENCES_KEY, data);
      toast({ title: t("settings.preferences.saved"), tone: "success" });
    },
    onError: (err) => {
      toast({ title: t("settings.preferences.saveFailed"), description: formatApiError(err), tone: "error" });
    },
  });
}
