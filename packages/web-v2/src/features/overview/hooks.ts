import { useQuery } from "@tanstack/react-query";
import { homeApi } from "./api";

export const homeKeys = {
  all: ["home"] as const,
  get: (orgId: string | null) => ["home", orgId] as const,
};

/** What is moving for what the person gave, across the projects they read; asked once the active org is resolved. */
export function useHome(orgId: string | null) {
  return useQuery({ queryKey: homeKeys.get(orgId), queryFn: () => homeApi.get(orgId), enabled: orgId !== null });
}
