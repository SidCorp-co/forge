"use client";

import { useQuery } from "@tanstack/react-query";
import { workflowsApi } from "./api";

export function useWorkflows(projectId: string | undefined) {
  return useQuery({
    queryKey: ["workflows", projectId ?? ""],
    queryFn: () => workflowsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}
