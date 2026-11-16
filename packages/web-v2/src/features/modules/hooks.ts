import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { capabilitiesApi, modulesApi } from "./api";
import { type FindFilters, findApi } from "./find";

// every read sits under ["issues","standing"], the prefix the event router already invalidates on
// every issue event, so a module's counts follow the issues they are counted from
const KEY = ["issues", "standing", "modules"] as const;

export const usePillar = (projectId: string | undefined) => useQuery(readOf([...KEY, projectId, "map"], () => modulesApi.pillar(projectId as string)));

export const useModuleTree = (projectId: string | undefined, module: string | undefined) =>
  useQuery(readOf([...KEY, projectId, "map", module], () => modulesApi.tree(projectId as string, module as string)));

export const useModuleDetail = (projectId: string | undefined, module: string | undefined) =>
  useQuery(readOf([...KEY, projectId, "detail", module], () => modulesApi.detail(projectId as string, module as string)));

/** One find; the last answer stays drawn while the next is asked, so the list never blinks empty. */
export function useFind(projectId: string | undefined, q: string, filters: FindFilters) {
  const query = q.trim();
  return useQuery({
    ...readOf(["find", projectId, query, filters], () => findApi.find(projectId as string, query, filters), 30_000),
    enabled: Boolean(projectId) && query.length > 0,
    placeholderData: keepPreviousData,
  });
}

export const useFindGaps = (projectId: string | undefined) => useQuery(readOf(["find", projectId, "gaps"], () => findApi.gaps(projectId as string), 60_000));

/** How long the Capabilities branch looks back: a door unused this long is due a decision (ISS-1251 §5). */
export const CAP_WINDOW_DAYS = 30;

export const capabilityKeys = {
  all: (projectId: string | undefined) => ["capabilities", projectId] as const,
  doors: (projectId: string | undefined) => [...capabilityKeys.all(projectId), "doors", CAP_WINDOW_DAYS] as const,
  piles: (projectId: string | undefined) => [...capabilityKeys.all(projectId), "piles"] as const,
  extra: (projectId: string | undefined) => [...capabilityKeys.all(projectId), "extra", CAP_WINDOW_DAYS] as const,
};

// counts over logs, read again a minute later at most: nothing on the branch moves by the second

/** Every door's use over the capabilities window, with its card. */
export const useDoorUse = (projectId: string | undefined) =>
  useQuery(readOf(capabilityKeys.doors(projectId), () => capabilitiesApi.doors(projectId as string, CAP_WINDOW_DAYS), 60_000));

/** Each pile every prompt carries, against its cap. */
export const usePiles = (projectId: string | undefined) => useQuery(readOf(capabilityKeys.piles(projectId), () => capabilitiesApi.piles(projectId as string), 60_000));

/** The reports agents filed on a door and the lessons on its card. */
export const useCapabilityExtra = (projectId: string | undefined) =>
  useQuery(readOf(capabilityKeys.extra(projectId), () => capabilitiesApi.extra(projectId as string, CAP_WINDOW_DAYS), 60_000));
