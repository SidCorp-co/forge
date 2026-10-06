import { useQuery } from "@tanstack/react-query";
import { developmentApi } from "./api";

// keyed under ['issues','standing'] so the event router, which invalidates that prefix on every issue event, refreshes the overview as it refreshes the Issues views
export function useDevelopmentOverview(projectId: string | undefined) {
  return useQuery({
    queryKey: ["issues", "standing", "development-overview", projectId ?? ""],
    queryFn: () => developmentApi.overview(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}
