
import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useLabel } from "@/lib/i18n/interface-language";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { workflowsApi } from "./api";
import type { CanvasHealth } from "./canvas/workflow-canvas";
import { edgeHealthOf, HEALTH_PARAM, type HealthSurface, LAYER_PARAM, layerOf, nodeHealthOf, overlayOn, sourceHref } from "./health";
import { builtinTemplateWords } from "./template-words";
import type { DesignDecisionBody, RepinActBody, SystemGraphRef, WorkflowTemplateList } from "./types";

/** Every query key the workflows feature reads under; a key without its workflow is the prefix of every design's. */
const workflowKeys = {
  list: (projectId: string | undefined) => ["workflows", projectId] as const,
  design: (projectId: string | undefined, workflowId?: string) => ["workflow-design", projectId, ...(workflowId === undefined ? [] : [workflowId])] as const,
  health: (projectId: string | undefined, workflowId?: string) => ["workflow-health", projectId, ...(workflowId === undefined ? [] : [workflowId])] as const,
  repins: (projectId: string | undefined, workflowId?: string) => ["workflow-repins", projectId, ...(workflowId === undefined ? [] : [workflowId])] as const,
};

export const useWorkflows = (projectId: string | undefined) => useQuery(readOf(workflowKeys.list(projectId), () => workflowsApi.list(projectId as string)));

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
  return useQuery({ ...readOf(["workflow-templates", projectId], () => workflowsApi.templates(projectId as string), 5 * 60_000), select });
}

export const useWorkflowDesign = (projectId: string | undefined, workflowId: string | undefined) =>
  useQuery(readOf(["workflow-design", projectId, workflowId], () => workflowsApi.design(projectId as string, workflowId as string)));

/** One design's health: every marker, node reading and count, from core's one read model (REQ-17 BC-19). */
export const useWorkflowHealth = (projectId: string | undefined, workflowId: string | undefined) =>
  useQuery(readOf(["workflow-health", projectId, workflowId], async () => (await workflowsApi.health(projectId as string, workflowId as string)).health));

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
export const useSystemGraph = (ref: SystemGraphRef | null) =>
  useQuery({
    ...readOf(["system-graph", ref?.projectId, ref?.workflowId, ref?.revision ?? 0, ref?.against ?? 0], () => workflowsApi.systemGraph(ref as SystemGraphRef), 5 * 60_000),
    enabled: ref !== null,
  });

/** FB-86: drafts a requirement from a design no requirement roots; the design and the list read again. */
export const useDraftRequirementFromDesign = (projectId: string, workflowId: string) =>
  useWrite((body: { title: string; designs: string[] }) => workflowsApi.draftRequirement(projectId, body), {
    touches: [workflowKeys.design(projectId, workflowId), workflowKeys.health(projectId, workflowId), ["requirements", projectId]],
  });

/** Approving a base, or one of its dependents, also changes what the re-pin act would take. */
export const useDesignDecision = (projectId: string, workflowId: string) =>
  useWrite((body: DesignDecisionBody) => workflowsApi.decide(projectId, workflowId, body), {
    touches: [workflowKeys.list(projectId), workflowKeys.design(projectId, workflowId), workflowKeys.health(projectId, workflowId), workflowKeys.repins(projectId)],
  });

/** What one act approving this base's pin-only dependents would do now; core plans it, nothing here decides membership. */
export const useRepinPlan = (projectId: string | undefined, workflowId: string | undefined) =>
  useQuery(readOf(["workflow-repins", projectId, workflowId], () => workflowsApi.repins(projectId as string, workflowId as string)));

/** The re-pin act: every design it approved moves, so every design read of the project is read again (Needs you re-reads on any settled write). */
export const useRepinAct = (projectId: string, workflowId: string) =>
  useWrite((body: RepinActBody) => workflowsApi.repin(projectId, workflowId, body), {
    touches: [workflowKeys.list(projectId), workflowKeys.design(projectId), workflowKeys.health(projectId), workflowKeys.repins(projectId)],
  });
