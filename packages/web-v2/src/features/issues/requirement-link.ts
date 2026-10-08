// The issue side of a requirement link: an issue names the requirement it delivers through the
// requirement's own routes, and the list it picks from is the project's agreed requirements.

import type { RequirementCoverage, RequirementDetail, RequirementSummaryView } from "@forge/contracts/requirements";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

const linksOf = (projectId: string, req: string) => `/projects/${projectId}/requirements/${encodeURIComponent(req)}/issues`;

/** The requirements an issue may be linked to: agreed or accepted ones, as core lists them. */
export function useLinkableRequirements(projectId: string | undefined) {
  return useQuery({
    queryKey: ["requirements", projectId ?? "", "linkable"],
    queryFn: async () => {
      const list = await apiClient<{ requirements: RequirementSummaryView[] }>(`/projects/${projectId}/requirements?view=summary`);
      return list.requirements.filter((r) => r.status === "agreed" || r.status === "accepted");
    },
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

/**
 * The business criteria of the requirement an issue delivers, each with the issues already tracing
 * it, read from the requirement's own detail (the requirement page's cache entry, so both read alike).
 */
export function useRequirementCriteria(projectId: string, req: string | null) {
  return useQuery({
    queryKey: ["requirement", projectId, req ?? ""],
    queryFn: () => apiClient<RequirementDetail>(`/projects/${projectId}/requirements/${encodeURIComponent(req as string)}`),
    enabled: Boolean(req),
    staleTime: 15_000,
    select: (d): RequirementCoverage[] => d.standing.coverage,
  });
}

/** Links the issue to `req`, or unlinks it from `req`; the issue's standing and the requirement re-read after. */
export function useIssueRequirementLink(projectId: string, issueKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { req: string; unlink: boolean }) =>
      a.unlink
        ? apiClient<unknown>(`${linksOf(projectId, a.req)}/${encodeURIComponent(issueKey)}`, { method: "DELETE" })
        : apiClient<unknown>(linksOf(projectId, a.req), { method: "POST", body: JSON.stringify({ issue: issueKey }) }),
    onSettled: (_d, _e, a) => {
      qc.invalidateQueries({ queryKey: ["issues", "standing"] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, a.req] });
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
    },
  });
}
