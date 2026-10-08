"use client";

import { PROJECT_STATUS_DAYS_DEFAULT } from "@forge/contracts/project-status";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createShare } from "@/features/shares";
import { projectStatusApi } from "./api";

/** Every key of this read starts here, so an issue or question event refreshes it in one call. */
export const PROJECT_STATUS_ROOT = ["project-status"] as const;

/** The stored reports, under their own root: a stored report never changes, so no event refreshes it. */
const STATUS_REPORTS_ROOT = ["status-reports"] as const;

export function useProjectStatus(projectId: string | undefined, days: number = PROJECT_STATUS_DAYS_DEFAULT) {
  return useQuery({
    queryKey: [...PROJECT_STATUS_ROOT, projectId ?? "", days],
    queryFn: () => projectStatusApi.read(projectId as string, days),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useStatusReports(projectId: string) {
  return useQuery({
    queryKey: [...STATUS_REPORTS_ROOT, projectId],
    queryFn: () => projectStatusApi.reports(projectId),
    staleTime: 15_000,
  });
}

export function useStatusReport(projectId: string, reportId: string | null) {
  return useQuery({
    queryKey: [...STATUS_REPORTS_ROOT, projectId, reportId ?? ""],
    queryFn: () => projectStatusApi.report(projectId, reportId as string),
    enabled: Boolean(reportId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** "Save report": keep the read as it stands now, then list it. */
export function useSaveStatusReport(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => projectStatusApi.save(projectId, days),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...STATUS_REPORTS_ROOT, projectId] }),
  });
}

/** Remove one kept report: core lets its saver or a project admin, and refuses anyone else by name. */
export function useDeleteStatusReport(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) => projectStatusApi.remove(projectId, reportId),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...STATUS_REPORTS_ROOT, projectId] }),
  });
}

/** Share one kept template report with the project's members; the link is shown once, by the caller. */
export function useShareTemplateReport(projectId: string) {
  return useMutation({
    mutationFn: (reportId: string) => createShare(projectId, { subjectKind: "status-report", subjectId: reportId, audience: "members" }),
  });
}
