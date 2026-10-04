"use client";

import { useQuery } from "@tanstack/react-query";
import { modulesApi } from "./api";

// cm:why both reads sit under ["issues","standing"], the prefix the event router already invalidates on
// every issue event, so a module's counts follow the issues they are counted from
const KEY = ["issues", "standing", "modules"] as const;

export function useModuleRollup(projectId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, projectId ?? "", "rollup"],
    queryFn: () => modulesApi.rollup(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

/** The build's requirement trace: which requirements and workflow steps each code module serves. */
export function useCodeTrace() {
  return useQuery({ queryKey: ["code-trace"], queryFn: modulesApi.trace, staleTime: Infinity });
}

export function useModuleDetail(projectId: string | undefined, module: string | undefined) {
  return useQuery({
    queryKey: [...KEY, projectId ?? "", "detail", module ?? ""],
    queryFn: () => modulesApi.detail(projectId as string, module as string),
    enabled: Boolean(projectId && module),
    staleTime: 15_000,
  });
}
