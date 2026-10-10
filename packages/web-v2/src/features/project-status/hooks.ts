
import { PROJECT_STATUS_DAYS_DEFAULT } from "@forge/contracts/project-status";
import { useMutation, useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { saveFile } from "@/lib/utils/save-file";
import { STATUS_REPORTS_ROOT } from "@/features/shares";
import { projectStatusApi } from "./api";

/** Every key of this read starts here, so an issue or question event refreshes it in one call. */
const PROJECT_STATUS_ROOT = ["project-status"] as const;

export const useProjectStatus = (projectId: string | undefined, days: number = PROJECT_STATUS_DAYS_DEFAULT) =>
  useQuery(readOf([...PROJECT_STATUS_ROOT, projectId, days], () => projectStatusApi.read(projectId as string, days)));

export const useStatusReports = (projectId: string) => useQuery(readOf([...STATUS_REPORTS_ROOT, projectId], () => projectStatusApi.reports(projectId)));

/** A kept report never changes. */
export const useStatusReport = (projectId: string, reportId: string | null) =>
  useQuery(readOf([...STATUS_REPORTS_ROOT, projectId, reportId], () => projectStatusApi.report(projectId, reportId as string), Number.POSITIVE_INFINITY));

/** "Save report": keep the read as it stands now, then list it. */
export const useSaveStatusReport = (projectId: string) =>
  useWrite((days: number) => projectStatusApi.save(projectId, days), { touches: [[...STATUS_REPORTS_ROOT, projectId]] });

/** The templates this build offers; they change only with a deploy. */
export const useReportTemplates = (projectId: string | undefined) =>
  useQuery(readOf(["report-templates", projectId], () => projectStatusApi.templates(projectId as string), Number.POSITIVE_INFINITY));

/** Run one template as the reader: each run is the reader's, so only they can keep it. */
export function useRunTemplate(projectId: string) {
  return useMutation({
    mutationFn: (a: { templateId: string; params: Record<string, string | number | boolean> }) =>
      projectStatusApi.runTemplate(projectId, a.templateId, a.params),
  });
}

/** Remove one kept report: core lets its saver or a project admin, and refuses anyone else by name. */
export const useDeleteStatusReport = (projectId: string) =>
  useWrite((reportId: string) => projectStatusApi.remove(projectId, reportId), { touches: [[...STATUS_REPORTS_ROOT, projectId]] });

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
