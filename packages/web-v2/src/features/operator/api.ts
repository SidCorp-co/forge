import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  AdminAdoptionBucket,
  AdminAlert,
  AdminOverview,
  AdminWorkspaceRow,
  OperatorWhoami,
  OperatorWindow,
  OperatorWorkspaceSort,
} from "./types";

/** Every project on the deployment fits well inside the endpoint's cap of 100,
 *  and the operator table wants the whole set to sort and to derive its WS
 *  room list from — not a first page. */
const WORKSPACE_LIMIT = 100;

export const operatorApi = {
  whoami: () => apiClient<OperatorWhoami>("/admin/whoami"),

  overview: (window: OperatorWindow) =>
    apiClient<AdminOverview>(`/admin/overview?window=${window}`),

  alerts: () => apiClientList<AdminAlert>("/admin/alerts"),

  adoption: (weeks: number) =>
    apiClient<AdminAdoptionBucket[]>(`/admin/adoption?weeks=${weeks}&bucket=week`),

  workspaces: (window: OperatorWindow, sort: OperatorWorkspaceSort) =>
    apiClientList<AdminWorkspaceRow>(
      `/admin/workspaces?window=${window}&sort=${sort}&limit=${WORKSPACE_LIMIT}`,
    ),

  // cm:edge contract -> packages/core/src/jobs/lifecycle-routes.ts — that route's member check falls back to the ADMIN_EMAILS allow-list precisely so this call works for a job in a tenant the operator is not a member of; there is deliberately no `/api/admin/jobs/:id/reap`, because two cancel paths is one more than `cancelJob` can audit
  reapJob: (jobId: string) =>
    apiClient<{ status: string }>(`/jobs/${jobId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "reaped from the Operator Ops Console" }),
    }),
};
