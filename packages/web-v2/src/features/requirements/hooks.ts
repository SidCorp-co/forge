"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requirementsApi } from "./api";
import type { CreateRequirementBody, RequirementAction, RequirementDetail } from "./types";

export function useRequirements(projectId: string | undefined) {
  return useQuery({
    queryKey: ["requirements", projectId ?? ""],
    queryFn: () => requirementsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useRequirement(projectId: string | undefined, req: string | undefined) {
  return useQuery({
    queryKey: ["requirement", projectId ?? "", req ?? ""],
    queryFn: () => requirementsApi.get(projectId as string, req as string),
    enabled: Boolean(projectId && req),
    staleTime: 15_000,
  });
}

export function useCreateRequirement(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequirementBody) => requirementsApi.create(projectId, body),
    onSettled: () => qc.invalidateQueries({ queryKey: ["requirements", projectId] }),
  });
}

/** Propose, accept, return or agree. The detail it answers with is the one the screen shows next. */
export function useRequirementAction(projectId: string, req: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: RequirementAction) => requirementsApi.act(projectId, req, action),
    onSuccess: (detail: RequirementDetail) => qc.setQueryData(["requirement", projectId, req], detail),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
    },
  });
}
