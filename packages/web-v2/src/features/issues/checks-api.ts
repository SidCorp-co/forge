import type { IssueChecksView } from "@forge/contracts/check-runs";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

// The checks an issue's runs made, each with its kind and duration, and the time spent per kind
// (REQ-36 BC-14; ISS-474). Keyed under `['issue', id]`, which the event router invalidates.

export const checksApi = {
  /** `GET /api/issues/:id/checks` — every recorded check, newest first, and the time per kind. */
  list: (issueId: string) => apiClient<IssueChecksView>(`/issues/${issueId}/checks`),
};

export function useIssueChecks(issueId: string | undefined) {
  return useQuery({
    queryKey: ["issue", issueId, "checks"],
    queryFn: () => checksApi.list(issueId as string),
    enabled: !!issueId,
  });
}
