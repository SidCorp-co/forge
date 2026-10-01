import { apiClient } from "@/lib/api/client";
import type {
  ReleaseApproval,
  ReleaseDecisionBody,
  ReleaseVersionDetail,
  ReleaseVersionList,
} from "./versions-types";

export const releaseVersionsApi = {
  list: (projectId: string) => apiClient<ReleaseVersionList>(`/projects/${projectId}/releases`),
  get: (projectId: string, version: string) =>
    apiClient<ReleaseVersionDetail>(`/projects/${projectId}/releases/${encodeURIComponent(version)}`),
  decide: (projectId: string, runId: string, approvalId: string, body: ReleaseDecisionBody) =>
    apiClient<ReleaseApproval>(
      `/projects/${projectId}/release-batches/${runId}/approvals/${approvalId}/decision`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  cut: (projectId: string, issueIds: string[]) =>
    apiClient<{ runId: string; version: string }>(`/projects/${projectId}/release-batches`, {
      method: "POST",
      body: JSON.stringify({ issueIds }),
    }),
};
