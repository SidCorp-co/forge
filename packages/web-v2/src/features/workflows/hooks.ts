"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workflowsApi } from "./api";
import type { DesignDecisionBody, SystemGraphRef } from "./types";

export function useWorkflows(projectId: string | undefined) {
  return useQuery({
    queryKey: ["workflows", projectId ?? ""],
    queryFn: () => workflowsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

/** The diagram templates this project draws in: the built-ins, then its own. They change on a deploy or a project-document write. */
export function useWorkflowTemplates(projectId: string | undefined) {
  return useQuery({
    queryKey: ["workflow-templates", projectId ?? ""],
    queryFn: () => workflowsApi.templates(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 5 * 60_000,
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

/** A system-context design read as its graph by core; a revision's content never changes, so neither does its graph. */
export function useSystemGraph(ref: SystemGraphRef | null) {
  return useQuery({
    queryKey: ["system-graph", ref?.projectId ?? "", ref?.workflowId ?? "", ref?.revision ?? 0, ref?.against ?? 0],
    queryFn: () => workflowsApi.systemGraph(ref as SystemGraphRef),
    enabled: ref !== null,
    staleTime: 5 * 60_000,
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
