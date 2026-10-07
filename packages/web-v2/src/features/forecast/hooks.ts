import { useQuery } from "@tanstack/react-query";
import { forecastApi } from "./api";

// keyed under ['issues','standing'] so the event router, which invalidates that prefix on every issue
// event, recomputes the forecast on each transition with no timer of its own
const KEY = ["issues", "standing", "forecast"] as const;

export function useProjectForecast(projectId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "project", projectId ?? ""],
    queryFn: () => forecastApi.project(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useIssueForecast(projectId: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "issue", projectId ?? "", key ?? ""],
    queryFn: () => forecastApi.issue(projectId as string, key as string),
    enabled: Boolean(projectId && key),
    staleTime: 10_000,
  });
}

export function useRequirementForecast(projectId: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "requirement", projectId ?? "", key ?? ""],
    queryFn: () => forecastApi.requirement(projectId as string, key as string),
    enabled: Boolean(projectId && key),
    staleTime: 10_000,
  });
}

export function useDraftReleaseForecast(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "release-draft", projectId ?? ""],
    queryFn: () => forecastApi.draftRelease(projectId as string),
    enabled: Boolean(projectId) && enabled,
    staleTime: 10_000,
  });
}
