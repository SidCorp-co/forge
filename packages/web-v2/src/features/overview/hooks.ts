import { useQuery } from "@tanstack/react-query";
import { homeApi, pulseApi } from "./api";

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

/** The shortest text the home's search sends: core refuses a shorter one. */
export const HOME_FIND_MIN = 2;

export const homeKeys = {
  all: ["home"] as const,
  get: (orgId: string | null) => ["home", orgId] as const,
  find: (text: string, orgId: string | null) => ["home", "find", text, orgId] as const,
};

/** What is moving for what the person gave and what is live, across the projects they read; asked once the active org is resolved, as the pulse is. */
export function useHome(orgId: string | null) {
  return useQuery({ queryKey: homeKeys.get(orgId), queryFn: () => homeApi.get(orgId), enabled: orgId !== null });
}

/** Where any item stands, by key or title word; asked only once the text is long enough. */
export function useHomeFind(text: string, orgId: string | null) {
  const q = text.trim();
  return useQuery({
    queryKey: homeKeys.find(q, orgId),
    queryFn: () => homeApi.find(q, orgId),
    enabled: orgId !== null && q.length >= HOME_FIND_MIN,
  });
}
