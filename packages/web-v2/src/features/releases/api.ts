import { type ReleasePage, type ReleasePageViewKind, releasePagePath } from "@forge/contracts/release-page";
import { apiClient } from "@/lib/api/client";
import type { ReleaseApprovalView, ReleaseDecisionBody, ReleaseDraftApprovalView, ReleaseListResponse, ReleaseResponse } from "./types";

export const releasesApi = {
  list: (projectId: string) => apiClient<ReleaseListResponse>(`/projects/${projectId}/releases`),
  get: (projectId: string, version: string) =>
    apiClient<ReleaseResponse>(`/projects/${projectId}/releases/${encodeURIComponent(version)}`),
  /** The release as a reader reads it (`releasePagePath`, which names the /api prefix the client adds). */
  page: (projectId: string, version: string, view: ReleasePageViewKind) =>
    apiClient<ReleasePage>(releasePagePath(projectId, version, view).replace(/^\/api/, "")),
  decide: (projectId: string, runId: string, approvalId: string, body: ReleaseDecisionBody) =>
    apiClient<ReleaseApprovalView>(
      `/projects/${projectId}/release-batches/${runId}/approvals/${approvalId}/decision`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** A draft's decision, keyed on its version, on a project that declares no production (ISS-869). */
  decideDraft: (projectId: string, version: string, body: ReleaseDecisionBody) =>
    apiClient<ReleaseDraftApprovalView>(`/projects/${projectId}/releases/${encodeURIComponent(version)}/approval`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cut: (projectId: string, issueIds: string[]) =>
    apiClient<{ runId: string; version: string }>(`/projects/${projectId}/release-batches`, {
      method: "POST",
      body: JSON.stringify({ issueIds }),
    }),
};
