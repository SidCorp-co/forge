"use client";

import { PROJECT_STATUS_DAYS_DEFAULT } from "@forge/contracts/project-status";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveFile } from "@/lib/utils/save-file";
import { STATUS_REPORTS_ROOT } from "@/features/shares";
import { projectStatusApi } from "./api";

/** Every key of this read starts here, so an issue or question event refreshes it in one call. */
export const PROJECT_STATUS_ROOT = ["project-status"] as const;

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

/** Keep a template's runs as a report, then list it: from a chat answer, or from a template run on this page. */

/** The templates this build offers; they change only with a deploy. */
export function useReportTemplates(projectId: string | undefined) {
  return useQuery({
    queryKey: ["report-templates", projectId ?? ""],
    queryFn: () => projectStatusApi.templates(projectId as string),
    enabled: Boolean(projectId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Run one template as the reader: each run is the reader's, so only they can keep it. */
export function useRunTemplate(projectId: string) {
  return useMutation({
    mutationFn: (a: { templateId: string; params: Record<string, string | number | boolean> }) =>
      projectStatusApi.runTemplate(projectId, a.templateId, a.params),
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


/**
 * Saves what core exports for a kept template report: the Markdown with no table named, or that
 * table block's CSV. Core builds every export; this only hands its file to the browser.
 */
export function useExportStatusReport(projectId: string, reportId: string, fallbackName: string) {
  return useMutation({
    mutationFn: async (table?: number) => {
      const file = await projectStatusApi.exportFile(projectId, reportId, table);
      saveFile(file.name ?? `${fallbackName}${table === undefined ? ".md" : `-block-${table + 1}.csv`}`, file.blob);
    },
  });
}
