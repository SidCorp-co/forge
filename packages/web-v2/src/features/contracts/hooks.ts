"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { contractsApi, decideVersion } from "./api";

// both reads sit under ["issues","standing"], the prefix the event router already invalidates on every issue event, so a contract's waits follow the issues that hold them
const KEY = ["issues", "standing", "contracts"] as const;

export function useContractStanding(projectId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, projectId ?? "", "list"],
    queryFn: () => contractsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useContractDetail(projectId: string | undefined, ref: string | undefined) {
  return useQuery({
    queryKey: [...KEY, projectId ?? "", "detail", ref ?? ""],
    queryFn: () => contractsApi.detail(projectId as string, ref as string),
    enabled: Boolean(projectId && ref),
    staleTime: 15_000,
  });
}

export function useDecideVersion(projectId: string, contract: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { version: string; decision: "approve" | "return"; reason?: string }) =>
      decideVersion(projectId, contract, v.version, { decision: v.decision, reason: v.reason }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
