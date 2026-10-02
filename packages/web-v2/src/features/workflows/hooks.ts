"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workflowsApi } from "./api";
import type { DesignDecisionBody } from "./types";

export function useWorkflows(projectId: string | undefined) {
  return useQuery({
    queryKey: ["workflows", projectId ?? ""],
    queryFn: () => workflowsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useWorkflowDesign(projectId: string | undefined, workflowId: string | undefined) {
  return useQuery({
    queryKey: ["workflow-design", projectId ?? "", workflowId ?? ""],
    queryFn: () => workflowsApi.design(projectId as string, workflowId as string),
    enabled: Boolean(projectId && workflowId),
    staleTime: 15_000,
  });
}

export function useDesignDecision(projectId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DesignDecisionBody) => workflowsApi.decide(projectId, workflowId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["workflows", projectId] });
      qc.invalidateQueries({ queryKey: ["workflow-design", projectId, workflowId] });
    },
  });
}

/** Designs waiting on their approver, for the Workflows menu badge. */
export function useDesignsAwaitingCount(projectId: string | undefined): number | undefined {
  const q = useWorkflows(projectId);
  return q.data?.workflows.filter((w) => w.design.status === "proposed").length;
}
