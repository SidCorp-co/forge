"use client";

import { PROJECT_STATUS_DAYS_DEFAULT } from "@forge/contracts/project-status";
import { useQuery } from "@tanstack/react-query";
import { projectStatusApi } from "./api";

/** Every key of this read starts here, so an issue or question event refreshes it in one call. */
export const PROJECT_STATUS_ROOT = ["project-status"] as const;

export function useProjectStatus(projectId: string | undefined, days: number = PROJECT_STATUS_DAYS_DEFAULT) {
  return useQuery({
    queryKey: [...PROJECT_STATUS_ROOT, projectId ?? "", days],
    queryFn: () => projectStatusApi.read(projectId as string, days),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}
