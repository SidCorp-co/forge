"use client";

import { useQuery } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { modulesApi } from "./api";

// both reads sit under ["issues","standing"], the prefix the event router already invalidates on
// every issue event, so a module's counts follow the issues they are counted from
const KEY = ["issues", "standing", "modules"] as const;

export const useModuleRollup = (projectId: string | undefined) => useQuery(readOf([...KEY, projectId, "rollup"], () => modulesApi.rollup(projectId as string)));

/** Forge's own requirement trace, empty for a project not built from Forge's repository. */
export function useCodeTrace(projectId: string) {
  return useQuery({ queryKey: ["code-trace", projectId], queryFn: () => modulesApi.trace(projectId), staleTime: Infinity });
}

export const useModuleDetail = (projectId: string | undefined, module: string | undefined) =>
  useQuery(readOf([...KEY, projectId, "detail", module], () => modulesApi.detail(projectId as string, module as string)));
