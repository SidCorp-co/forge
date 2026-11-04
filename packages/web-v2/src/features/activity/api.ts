import type { OrgActivity } from "@forge/contracts/org-activity";
import { apiClient } from "@/lib/api/client";

export const activityApi = {
  read: (orgId: string) => apiClient<OrgActivity>(`/orgs/${encodeURIComponent(orgId)}/activity`),
};
