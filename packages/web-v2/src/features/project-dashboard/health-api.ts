"use client";

import type { HealthWindow, ProjectHealth } from "@forge/contracts/project-health";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** The project's health over the chosen window (REQ-24), from `GET /projects/:id/metrics/health`. */
export function useProjectHealth(projectId: string | undefined, days: HealthWindow) {
  return useQuery({
    queryKey: ["project-health", projectId ?? "", days],
    queryFn: () => apiClient<ProjectHealth>(`/projects/${encodeURIComponent(projectId as string)}/metrics/health?days=${days}`),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}
