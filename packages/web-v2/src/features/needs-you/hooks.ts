"use client";

import { useQuery } from "@tanstack/react-query";
import { needsYouApi } from "./api";

/** Every key of this read starts here, so a write anywhere can refresh the counts in one call. */
export const NEEDS_YOU_ROOT = ["needs-you"] as const;
export const needsYouKey = (projectId: string) => [...NEEDS_YOU_ROOT, projectId] as const;

export function useNeedsYou(projectId: string | undefined) {
  return useQuery({
    queryKey: needsYouKey(projectId ?? ""),
    queryFn: () => needsYouApi.read(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export const needsYouDecisionsKey = (projectId: string) => [...NEEDS_YOU_ROOT, projectId, "decisions"] as const;

/** The decisions only the viewer can make (REQ-41 BC-1), the read the home and the chat share. */
export function useNeedsYouDecisions(projectId: string | undefined) {
  return useQuery({
    queryKey: needsYouDecisionsKey(projectId ?? ""),
    queryFn: () => needsYouApi.decisions(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}
