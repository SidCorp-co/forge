"use client";

import { useQuery } from "@tanstack/react-query";
import { pulseApi } from "./api";

/**
 * The workspace pulse, scoped to the active organization.
 */
export function usePulse(orgId: string | null) {
  // asked only once the active org is resolved: before it, the read would scope to a fallback org
  return useQuery({
    queryKey: ["pulse", orgId],
    queryFn: () => pulseApi.get(orgId ?? undefined),
    enabled: orgId !== null,
  });
}
