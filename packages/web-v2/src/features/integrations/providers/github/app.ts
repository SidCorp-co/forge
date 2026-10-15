// The instance's GitHub App as the workspace reaches it: Connect GitHub for an org, completing an App
// made before the instance had one, and what its directory row reads.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { GitHubAppRow, GitHubConnectStart } from "../../types";

export const githubAppApi = {
  /** `POST /api/integration-connections/github/connect` — for an org, not a project. */
  connect: (orgId: string, returnTo?: "integrations") =>
    apiClient<GitHubConnectStart>(`/integration-connections/github/connect`, {
      method: "POST",
      body: JSON.stringify({ orgId, ...(returnTo ? { returnTo } : {}) }),
    }),
  /** `POST /api/integration-connections/:id/github-app/complete` — operator only. */
  complete: (connectionId: string, clientSecret: string) =>
    apiClient<unknown>(`/integration-connections/${connectionId}/github-app/complete`, {
      method: "POST",
      body: JSON.stringify({ clientSecret }),
    }),
  row: (connectionId: string) => apiClient<GitHubAppRow>(`/integration-connections/${connectionId}/github-app`),
};

/** Connect GitHub for an org. Nothing is invalidated: nothing is recorded until GitHub returns. */
export function useOrgGitHubConnect(orgId: string | undefined) {
  return useMutation({
    mutationFn: (params: { returnTo?: "integrations" }) => githubAppApi.connect(orgId as string, params.returnTo),
  });
}

export function useCompleteGitHubApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { connectionId: string; clientSecret: string }) =>
      githubAppApi.complete(args.connectionId, args.clientSecret),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["integration-connections"] });
    },
  });
}

/** Keyed under the connection, so `integration.changed` refreshes it with the directory. */
export function useGitHubAppRow(connectionId: string | undefined) {
  return useQuery({
    queryKey: ["integration-connections", connectionId, "github-app"],
    queryFn: () => githubAppApi.row(connectionId as string),
    enabled: !!connectionId,
    retry: false,
  });
}
