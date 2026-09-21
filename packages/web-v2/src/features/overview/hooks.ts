"use client";

import { useQuery } from "@tanstack/react-query";
import { pulseApi } from "./api";

/**
 * The workspace pulse, scoped to the active organization.
 */
export function usePulse(orgId?: string) {
  return useQuery({
    queryKey: ["pulse", orgId ?? null],
    queryFn: () => pulseApi.get(orgId),
  });
}
