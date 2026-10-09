"use client";

import type { ShareCreate } from "@forge/contracts/shares";
import type { StatusReportMeta } from "@forge/contracts/status-reports";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { sharesApi } from "./api";
import type { TemplateSave } from "./subject";

/**
 * The key of a project's kept status reports. It lives here, below the Status page, because both a
 * chat answer's Save report and the Status page's own save refresh it; project-status reads it from here.
 */
export const STATUS_REPORTS_ROOT = ["status-reports"] as const;

/**
 * Keeps a template run as a status report (`POST /projects/:id/status/reports`): its template, its
 * runs in order, the narrative slots written and each block's finding. Core reads each run back as
 * the saver and judges the narrative and findings against them; a refusal names what is wrong and
 * nothing is kept.
 */
export function useSaveTemplateReport(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TemplateSave) =>
      apiClient<StatusReportMeta>(`/projects/${encodeURIComponent(projectId)}/status/reports`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...STATUS_REPORTS_ROOT, projectId] }),
  });
}

const sharesKey = (projectId: string | undefined) => ["project", projectId, "shares"] as const;

export function useShares(projectId: string | undefined) {
  return useQuery({
    queryKey: sharesKey(projectId),
    queryFn: () => sharesApi.list(projectId as string),
    enabled: Boolean(projectId),
  });
}

/** Read each time the dialog opens: a grant or the data policy may have changed since. */
export function useShareAudiences(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...sharesKey(projectId), "audiences"],
    queryFn: () => sharesApi.audiences(projectId as string),
    enabled: Boolean(projectId) && enabled,
    staleTime: 0,
    retry: false,
  });
}

export function useCreateShare(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ShareCreate) => sharesApi.create(projectId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey(projectId) }),
  });
}

/** Revoking answers nothing the list trusts: the row reads revoked once the list is read again. */
export function useRevokeShare(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => sharesApi.revoke(projectId, shareId),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey(projectId) }),
  });
}
