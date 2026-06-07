"use client";

// web-v2 feature module: app-config — React Query hooks. Keyed `['app-config',
// projectId]`. The upsert mutation invalidates that key and toasts, following
// the `useUpdateProject` pattern in `features/project-settings/hooks.ts`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { appConfigApi } from "./api";
import type { AppConfigPatch } from "./types";

export const appConfigKeys = {
  detail: (projectId: string | undefined) => ["app-config", projectId] as const,
};

/** GET the project's app-config (returns `null` when no row exists yet). */
export function useAppConfig(projectId: string | undefined) {
  return useQuery({
    queryKey: appConfigKeys.detail(projectId),
    queryFn: () => appConfigApi.get(projectId as string),
    enabled: !!projectId,
  });
}

/** PUT a partial app-config patch (owner/admin only, server-gated). */
export function useUpsertAppConfig(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (patch: AppConfigPatch) => appConfigApi.upsert(projectId as string, patch),
    onSuccess: (data) => {
      qc.setQueryData(appConfigKeys.detail(projectId), data);
      qc.invalidateQueries({ queryKey: appConfigKeys.detail(projectId) });
      toast({ title: "Agent settings saved", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't save agent settings", description: formatApiError(err), tone: "error" }),
  });
}
