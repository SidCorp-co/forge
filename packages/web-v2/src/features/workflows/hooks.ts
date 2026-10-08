"use client";

import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useLabel } from "@/lib/i18n/interface-language";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { workflowsApi } from "./api";
import type { CanvasHealth } from "./canvas/workflow-canvas";
import { edgeHealthOf, HEALTH_PARAM, type HealthSurface, LAYER_PARAM, layerOf, nodeHealthOf, overlayOn, sourceHref } from "./health";
import { builtinTemplateWords } from "./template-words";
import type { DesignDecisionBody, RepinActBody, SystemGraphRef, WorkflowTemplateList } from "./types";

export function useWorkflows(projectId: string | undefined) {
  return useQuery({
    queryKey: ["workflows", projectId ?? ""],
    queryFn: () => workflowsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

/** The diagram templates this project draws in: the built-ins, then its own. They change on a deploy or a project-document write. The built-ins read in the interface language; the project's own as written. */
export function useWorkflowTemplates(projectId: string | undefined) {
  const label = useLabel();
  const select = useCallback(
    (list: WorkflowTemplateList): WorkflowTemplateList => ({
      ...list,
      templates: list.templates.map((e) => (e.origin === "builtin" ? { ...e, template: builtinTemplateWords(e.template, label) } : e)),
    }),
    [label],
  );
  return useQuery({
    queryKey: ["workflow-templates", projectId ?? ""],
    queryFn: () => workflowsApi.templates(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 5 * 60_000,
    select,
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

/** One design's health: every marker, node reading and count, from core's one read model (REQ-17 BC-19). */
export function useWorkflowHealth(projectId: string | undefined, workflowId: string | undefined) {
  return useQuery({
    queryKey: ["workflow-health", projectId ?? "", workflowId ?? ""],
    queryFn: () => workflowsApi.health(projectId as string, workflowId as string).then((r) => r.health),
    enabled: Boolean(projectId && workflowId),
    staleTime: 15_000,
  });
}

/** The Health overlay and layer the page address keeps (`health`, `layer`), over one design's health read. */
export function useHealthOverlay(health: WorkflowHealth | undefined, surface: HealthSurface, slug: string, flow: string): CanvasHealth | null {
  const [overlayParam, setOverlay] = useQueryParam(HEALTH_PARAM);
  const [layerParam, setLayer] = useQueryParam(LAYER_PARAM);
  const nodes = useMemo(() => (health ? nodeHealthOf(health) : null), [health]);
  const edges = useMemo(() => (health ? edgeHealthOf(health) : null), [health]);
  return useMemo(() => {
    if (!health || !nodes || !edges) return null;
    const observed = health.observation !== null;
    return {
      on: overlayOn(overlayParam, surface),
      onToggle: (on: boolean) => setOverlay(on ? "on" : "off"),
      layer: layerOf(layerParam, observed),
      onLayer: setLayer,
      observed,
      nodes,
      edges,
      hrefOf: (m) => sourceHref(slug, flow, m.source),
    };
  }, [health, nodes, edges, overlayParam, layerParam, surface, slug, flow, setOverlay, setLayer]);
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
      qc.invalidateQueries({ queryKey: ["workflow-health", projectId, workflowId] });
      // approving a base, or one of its dependents, changes what the re-pin act would take
      qc.invalidateQueries({ queryKey: ["workflow-repins", projectId] });
    },
  });
}

/** What one act approving this base's pin-only dependents would do now; core plans it, nothing here decides membership. */
export function useRepinPlan(projectId: string | undefined, workflowId: string | undefined) {
  return useQuery({
    queryKey: ["workflow-repins", projectId ?? "", workflowId ?? ""],
    queryFn: () => workflowsApi.repins(projectId as string, workflowId as string),
    enabled: Boolean(projectId && workflowId),
    staleTime: 15_000,
  });
}

/** The re-pin act: every design it approved moves, so every design read of the project is read again (Needs you re-reads on any settled write). */
export function useRepinAct(projectId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RepinActBody) => workflowsApi.repin(projectId, workflowId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["workflows", projectId] });
      qc.invalidateQueries({ queryKey: ["workflow-design", projectId] });
      qc.invalidateQueries({ queryKey: ["workflow-health", projectId] });
      qc.invalidateQueries({ queryKey: ["workflow-repins", projectId] });
    },
  });
}
