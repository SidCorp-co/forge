// How the canvas and the rail read core's workflow health (workflow-step-health d-overlay,
// d-step-health): the overlay and layer the address keeps, and which node each marker sits on. Every
// marker, count and needs-you figure is core's; nothing here derives one.

import type {
  HealthMarker,
  HealthMarkerKind,
  HealthNode,
  MarkerSource,
  NodeProvenance,
  WorkflowHealth,
} from "@forge/contracts/workflow-health";
import { HEALTH_MARKER_KINDS } from "@forge/contracts/workflow-health";
import { feedbackHref } from "@/features/feedback/routes";
import { issuesHref } from "@/features/issues/routes";
import { requirementHref } from "@/features/requirements/routes";
import { workflowHref } from "./routes";
import type { WorkflowBody, WorkflowStep } from "./types";

export const HEALTH_PARAM = "health";
export const LAYER_PARAM = "layer";

/** Where the canvas is drawn: the overlay is off by default on a design page, on on the workflows overview (REQ-17 BC-15). */
export type HealthSurface = "design" | "overview";

export function overlayOn(param: string | null, surface: HealthSurface): boolean {
  if (param === "on") return true;
  if (param === "off") return false;
  return surface === "overview";
}

export const HEALTH_LAYERS = ["planned", "observed", "both"] as const;
export type HealthLayer = (typeof HEALTH_LAYERS)[number];

/** The layer the address names; absent, Both once the code has been observed, else Planned (REQ-17 BC-28). */
export function layerOf(param: string | null, observed: boolean): HealthLayer {
  if (!observed) return "planned";
  return (HEALTH_LAYERS as readonly string[]).includes(param ?? "") ? (param as HealthLayer) : "both";
}

/** An observed-only step is drawn under this prefix, so its id never meets a planned one. */
export const OBSERVED_PREFIX = "observed:";
export const isObservedId = (id: string) => id.startsWith(OBSERVED_PREFIX);

/** What one drawn node shows: its provenance, one dot per kind, and its rewrite reading. */
export interface NodeHealthView {
  provenance: NodeProvenance;
  kinds: HealthMarkerKind[];
  markers: HealthMarker[];
  /** "Rewrite due" until a decision names the node, then the decision. */
  rewrite: string | null;
}

const REWRITE_WORDS: Record<HealthNode["rewrite"], string | null> = {
  due: "Rewrite due",
  decided_rewrite: "Decided: rewrite",
  decided_keep: "Decided: keep",
  decided_delete: "Decided: delete",
  none: null,
};

const nodeId = (t: HealthMarker["target"]): string | null => {
  if (t.kind === "workflow") return null;
  if (t.kind === "step") return t.layer === "observed" ? `${OBSERVED_PREFIX}${t.step}` : t.step;
  return null;
};

const edgeId = (t: HealthMarker["target"]): string | null => {
  if (t.kind !== "edge") return null;
  const key = `${t.from}>${t.to}`;
  return t.layer === "observed" ? `${OBSERVED_PREFIX}${key}` : key;
};

const ordered = (kinds: Iterable<HealthMarkerKind>) => {
  const set = new Set(kinds);
  return HEALTH_MARKER_KINDS.filter((k) => set.has(k));
};

/** Each drawn step's health, keyed by the id the canvas draws it under. */
export function nodeHealthOf(health: WorkflowHealth): Map<string, NodeHealthView> {
  const out = new Map<string, NodeHealthView>();
  for (const n of health.nodes) {
    const id = nodeId(n.target);
    if (!id) continue;
    out.set(id, { provenance: n.provenance, kinds: ordered(n.kinds), markers: [], rewrite: REWRITE_WORDS[n.rewrite] });
  }
  for (const m of health.markers) {
    const id = nodeId(m.target);
    if (!id) continue;
    const at = out.get(id) ?? { provenance: "planned", kinds: [], markers: [], rewrite: null };
    at.markers.push(m);
    at.kinds = ordered([...at.kinds, m.kind]);
    out.set(id, at);
  }
  return out;
}

/** Each drawn edge's marker kinds, keyed `from>to` (observed edges under the prefix). */
export function edgeHealthOf(health: WorkflowHealth): Map<string, HealthMarkerKind[]> {
  const out = new Map<string, HealthMarkerKind[]>();
  for (const m of health.markers) {
    const id = edgeId(m.target);
    if (id) out.set(id, ordered([...(out.get(id) ?? []), m.kind]));
  }
  return out;
}

/**
 * The steps the canvas draws for a layer: Planned is the design; Observed the planned steps the code
 * matches plus the code the design does not hold; Both every planned step with that code beside it.
 */
export function stepsForLayer(doc: Pick<WorkflowBody, "steps">, health: WorkflowHealth | null, layer: HealthLayer): WorkflowStep[] {
  const observed = health?.observed;
  if (!observed || layer === "planned") return doc.steps;
  const matched = new Set(observed.steps.flatMap((s) => (s.matches ? [s.matches] : [])));
  const drawnAs = new Map(observed.steps.map((s) => [s.id, s.matches ?? `${OBSERVED_PREFIX}${s.id}`]));
  const planned = layer === "observed" ? doc.steps.filter((s) => matched.has(s.id)) : doc.steps;
  const extra: WorkflowStep[] = observed.steps
    .filter((s) => s.matches === null)
    .map((s) => ({
      id: `${OBSERVED_PREFIX}${s.id}`,
      title: s.title ?? s.id,
      does: s.does,
      after: s.after.flatMap((a) => {
        const id = drawnAs.get(a);
        return id ? [id] : [];
      }),
    }));
  const ids = new Set([...planned.map((s) => s.id), ...extra.map((s) => s.id)]);
  return [...planned, ...extra].map((s) => ({ ...s, after: s.after.filter((a) => ids.has(a)) }));
}

/** Markers grouped by kind, in dot order, for the rail's Health group. */
export function markersByKind(markers: readonly HealthMarker[]): { kind: HealthMarkerKind; markers: HealthMarker[] }[] {
  return HEALTH_MARKER_KINDS.flatMap((kind) => {
    const of = markers.filter((m) => m.kind === kind);
    return of.length ? [{ kind, markers: of }] : [];
  });
}

/**
 * Where a marker's source record opens: an issue in the issues list's peek, a requirement, a
 * feedback item or the design itself on its page, anything else at the link core served.
 */
export function sourceHref(slug: string, flow: string, s: MarkerSource): string | null {
  const iss = /^ISS-\d+/.exec(s.key)?.[0];
  const req = /^REQ-\d+/.exec(s.key)?.[0];
  switch (s.type) {
    case "issue":
    case "criterion_verdict":
    case "run":
      if (iss) return `${issuesHref(slug)}?peek=${encodeURIComponent(iss)}`;
      break;
    case "requirement_criterion":
      if (req) return requirementHref(slug, req);
      break;
    case "feedback":
      if (/^FB-\d+$/.test(s.key)) return feedbackHref(slug, s.key);
      break;
    case "design_revision":
      return `${workflowHref(slug, flow)}?tab=revisions`;
    case "workflow_observation":
      return workflowHref(slug, flow);
  }
  return s.href;
}

/** A target as words: the step, the line, or the whole design. */
export function targetWords(t: HealthMarker["target"]): string {
  if (t.kind === "workflow") return "The whole design";
  const where = t.layer === "observed" ? " (observed)" : "";
  return t.kind === "step" ? `${t.step}${where}` : `${t.from} → ${t.to}${t.label ? ` “${t.label}”` : ""}${where}`;
}
