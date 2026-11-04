import type { OrgActivity, OrgActivityRecent } from "@forge/contracts/org-activity";
import { apiClient } from "@/lib/api/client";

export const activityApi = {
  read: (orgId: string) => apiClient<OrgActivity>(`/orgs/${encodeURIComponent(orgId)}/activity`),
  recent: (orgId: string, projectId: string) =>
    apiClient<OrgActivityRecent>(`/orgs/${encodeURIComponent(orgId)}/activity/${encodeURIComponent(projectId)}/recent`),
};
