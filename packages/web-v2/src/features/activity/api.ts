import type { CleanupReportView, DebtLedgerView } from "@forge/contracts/cleanup";
import type { OrgActivity, OrgActivityRecent } from "@forge/contracts/org-activity";
import { apiClient } from "@/lib/api/client";

export const activityApi = {
  read: (orgId: string) => apiClient<OrgActivity>(`/orgs/${encodeURIComponent(orgId)}/activity`),
  recent: (orgId: string, projectId: string) =>
    apiClient<OrgActivityRecent>(`/orgs/${encodeURIComponent(orgId)}/activity/${encodeURIComponent(projectId)}/recent`),
  /** The project's debt ledger: its cleanup window, open debt and what is cleared (ISS-1051). */
  ledger: (projectId: string) => apiClient<DebtLedgerView>(`/projects/${encodeURIComponent(projectId)}/debts`),
  /** The project's current cleanup reports, newest first. */
  cleanupReports: (projectId: string) => apiClient<{ reports: CleanupReportView[] }>(`/projects/${encodeURIComponent(projectId)}/cleanup-reports`),
};
