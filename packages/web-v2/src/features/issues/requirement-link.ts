// The issue side of a requirement link: the business criteria of the requirement an issue delivers.
// Linking and unlinking is the agents' act through the requirement's own routes; no product page
// offers it (REQ-68 BC-6, ISS-687).

import type { RequirementCoverage, RequirementDetail } from "@forge/contracts/requirements";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

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
