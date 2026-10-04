import { SENSITIVE_DATA_LEVELS, type SensitiveDataLevel } from "@forge/contracts/data-policy";
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { LEGACY_V2_TEMPLATE } from "@forge/contracts/workflow-templates";
import { projectDescriptionOf } from "@/features/project-settings/project-document";
import { templateFor } from "./canvas/model";
import { readSystemGraph, SYSTEM_CONTEXT_TEMPLATE, type FactRow, type SystemGraph } from "./c4/graph";
import type { WorkflowRecord } from "./types";

export type Purpose = "system" | "journeys" | "lifecycles" | "integrations" | "data" | "decisions" | "service" | "other";

/** What a design is for, by the template it is drawn in. The order is the order the catalogue reads in. */
export const PURPOSES: readonly { id: Purpose; label: string; hint: string; templates: readonly string[] }[] = [
  { id: "system", label: "System", hint: "Where the product sits between its users and the systems around it.", templates: [SYSTEM_CONTEXT_TEMPLATE] },
  { id: "journeys", label: "Journeys", hint: "How work and people move through the product.", templates: ["operational-flow", "ux-flow"] },
  { id: "lifecycles", label: "Lifecycles", hint: "The states one thing passes through.", templates: ["state-machine"] },
  { id: "integrations", label: "Integrations", hint: "The calls between systems, in order.", templates: ["integration-sequence"] },
  { id: "data", label: "Data", hint: "Where data comes from, where it lands and who it reaches.", templates: ["data-flow"] },
  { id: "decisions", label: "Decisions", hint: "The tables behind a rule.", templates: ["decision-model"] },
  {
    id: "service",
    label: "Service",
    hint: "What the customer meets and what runs behind it.",
    templates: ["service-blueprint", "service-blueprint-cross-functional"],
  },
  { id: "other", label: "Other", hint: "Designs drawn in one of the project's own templates.", templates: [] },
];

/** The template a listed design names, or the one a design stored before templates is read in. */
export function templateIdOf(r: WorkflowRecord): string {
  const d = r.document;
  if (d.version === 2) return (d.template ?? LEGACY_V2_TEMPLATE).id;
  return d.kind === "state" ? "state-machine" : "operational-flow";
}

export function purposeOf(r: WorkflowRecord): Purpose {
  const id = templateIdOf(r);
  return PURPOSES.find((p) => p.templates.includes(id))?.id ?? "other";
}

/** A template's name as a person reads it; an unknown id is spelled out rather than shown raw. */
export function templateTitle(id: string, templates: readonly WorkflowTemplate[]): string {
  const t = templates.find((x) => x.id === id);
  if (t) return t.title;
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface CatalogueGroup {
  id: Purpose;
  label: string;
  hint: string;
  rows: WorkflowRecord[];
}

/** The designs grouped by purpose, each group most recently updated first; empty groups are left out. */
export function catalogue(records: readonly WorkflowRecord[]): CatalogueGroup[] {
  return PURPOSES.map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    rows: records
      .filter((r) => purposeOf(r) === p.id)
      .sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt)),
  })).filter((g) => g.rows.length > 0);
}

/** The design the overview is drawn from: an approved system context first, else the latest one. */
export function systemContextOf(records: readonly WorkflowRecord[]): WorkflowRecord | null {
  const all = records.filter((r) => templateIdOf(r) === SYSTEM_CONTEXT_TEMPLATE);
  const approved = all.filter((r) => r.design.status === "approved");
  const pick = (rs: WorkflowRecord[]) => [...rs].sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt))[0] ?? null;
  return pick(approved) ?? pick(all);
}

/** The journey the overview points to: the largest approved journey, else the largest one. */
export function mainJourneyOf(records: readonly WorkflowRecord[]): WorkflowRecord | null {
  const journeys = records.filter((r) => purposeOf(r) === "journeys");
  const rank = (r: WorkflowRecord) => (r.design.status === "approved" ? 1000 : 0) + r.document.steps.length;
  return [...journeys].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export interface OverviewFact {
  label: string;
  value: string;
  /** What the value counts, shown on hover or focus. */
  rows: FactRow[];
}

export interface SystemOverview {
  record: WorkflowRecord;
  graph: SystemGraph;
  facts: OverviewFact[];
  journey: WorkflowRecord | null;
}

/** What the top of Workflows says about the system: its context design, read as C4, and the facts it states. */
export function systemOverview(records: readonly WorkflowRecord[], templates: readonly WorkflowTemplate[]): SystemOverview | null {
  const record = systemContextOf(records);
  if (!record) return null;
  const doc = record.document;
  const graph = readSystemGraph(doc, templateFor(doc, templates));
  const f = graph.facts;
  const facts: OverviewFact[] = [
    { label: "Users", value: `${f.people.length} ${f.people.length === 1 ? "role" : "roles"}`, rows: f.people },
    { label: "External systems", value: `${f.externals}${f.namedBoundaries > 1 ? ` in ${f.namedBoundaries} boundaries` : ""}`, rows: f.boundaries },
  ];
  return { record, graph, facts, journey: mainJourneyOf(records) };
}

/** Where the overview's one line about the system came from. */
export type DescriptionSource = "project" | "purpose" | "summary";

export interface SystemDescription {
  text: string;
  source: DescriptionSource;
}

/** A text's first sentence: up to its first full stop, question or exclamation mark followed by a space. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^([\s\S]+?[.!?…])(?:\s|$)/u.exec(t);
  return (m?.[1] ?? t).trim();
}

/**
 * What the system is, in one line: the project's description; else the in-scope system's stated
 * purpose in its system-context design; else the first sentence of that design's summary, which records
 * how the design was drawn and so is only shown to a viewer who cannot write a description instead.
 */
export function describeSystem(projectDocument: unknown, o: SystemOverview): SystemDescription | null {
  const project = projectDescriptionOf(projectDocument);
  if (project) return { text: project, source: "project" };
  const purpose = o.graph.focal?.purpose;
  if (purpose) return { text: purpose, source: "purpose" };
  const first = firstSentence(o.record.document.summary);
  return first ? { text: first, source: "summary" } : null;
}

/** The data policy a project document declares, when it restricts anything; absent or `off` is nothing to show. */
export function sensitivityOf(document: unknown): SensitiveDataLevel | null {
  const v = document && typeof document === "object" ? (document as { sensitiveData?: unknown }).sensitiveData : undefined;
  const level = SENSITIVE_DATA_LEVELS.find((l) => l === v);
  return level && level !== "off" ? level : null;
}
