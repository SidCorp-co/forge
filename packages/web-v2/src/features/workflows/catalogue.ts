import { SENSITIVE_DATA_LEVELS, type SensitiveDataLevel } from "@forge/contracts/data-policy";
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { SYSTEM_CONTEXT_TEMPLATE } from "@forge/contracts/system-graph";
import { projectDescriptionOf } from "@/features/project-settings";
import type { Copy } from "@/lib/i18n/product-copy";
import { builtinTemplateTitle } from "./template-words";
import type { FactRow, SystemGraph, WorkflowRecord } from "./types";

export type Purpose = "system" | "journeys" | "lifecycles" | "integrations" | "data" | "decisions" | "service" | "other";

/** What a design is for, by the template it is drawn in. */
const PURPOSES: readonly { id: Purpose; templates: readonly string[] }[] = [
  { id: "system", templates: [SYSTEM_CONTEXT_TEMPLATE] },
  { id: "journeys", templates: ["operational-flow", "ux-flow"] },
  { id: "lifecycles", templates: ["state-machine"] },
  { id: "integrations", templates: ["integration-sequence"] },
  { id: "data", templates: ["data-flow"] },
  { id: "decisions", templates: ["decision-model"] },
  { id: "service", templates: ["service-blueprint", "service-blueprint-cross-functional"] },
  { id: "other", templates: [] },
];

/** The template a listed design names. */
export function templateIdOf(r: WorkflowRecord): string {
  const d = r.document;
  if (d.version === 2) return d.template.id;
  return d.kind === "state" ? "state-machine" : "operational-flow";
}

export function purposeOf(r: WorkflowRecord): Purpose {
  const id = templateIdOf(r);
  return PURPOSES.find((p) => p.templates.includes(id))?.id ?? "other";
}

/** A template's name as a person reads it: the loaded template's, else a built-in's by its id; an unknown id is spelled out rather than shown raw. */
export function templateTitle(id: string, templates: readonly WorkflowTemplate[], label: Parameters<typeof builtinTemplateTitle>[1]): string {
  const t = templates.find((x) => x.id === id);
  if (t) return t.title;
  const builtin = builtinTemplateTitle(id, label);
  if (builtin) return builtin;
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The designs a design builds on, among those listed: its bases and the designs its steps reference. */
function buildsOn(r: WorkflowRecord, listed: ReadonlySet<string>): Set<string> {
  const d = r.document;
  const named = [...(d.basedOn ?? []).map((b) => b.workflow), ...d.steps.flatMap((s) => (s.node?.refs ?? []).map((x) => x.flow))];
  return new Set(named.filter((f) => f !== d.flow && listed.has(f)));
}

/**
 * The order a first-time reader reads the designs in (REQ-10 BC-12): each after every design it builds
 * on, ties by title. Designs that build on one another in a ring cannot all come after each other; they
 * follow the rest, by title.
 */
export function readingOrder(records: readonly WorkflowRecord[]): WorkflowRecord[] {
  const byTitle = (a: WorkflowRecord, b: WorkflowRecord) => a.document.title.localeCompare(b.document.title) || a.document.flow.localeCompare(b.document.flow);
  const listed = new Set(records.map((r) => r.document.flow));
  const waits = new Map(records.map((r) => [r.document.flow, buildsOn(r, listed)]));
  const out: WorkflowRecord[] = [];
  let left = [...records].sort(byTitle);
  while (left.length > 0) {
    const placed = new Set(out.map((r) => r.document.flow));
    const next = left.find((r) => [...(waits.get(r.document.flow) ?? [])].every((f) => placed.has(f)));
    if (!next) {
      out.push(...left);
      break;
    }
    out.push(next);
    left = left.filter((r) => r !== next);
  }
  return out;
}

/** The design the overview is drawn from: an approved system context first, else the latest one. */
export function systemContextOf(records: readonly WorkflowRecord[]): WorkflowRecord | null {
  const all = records.filter((r) => templateIdOf(r) === SYSTEM_CONTEXT_TEMPLATE);
  const approved = all.filter((r) => r.design.status === "approved");
  const pick = (rs: WorkflowRecord[]) => [...rs].sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt))[0] ?? null;
  return pick(approved) ?? pick(all);
}

/** The journey the overview points to: the largest approved journey, else the largest one. */
function mainJourneyOf(records: readonly WorkflowRecord[]): WorkflowRecord | null {
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
  journey: WorkflowRecord | null;
}

/** What the top of Workflows is drawn from: the system-context design, and the journey it points to. */
export function systemOverview(records: readonly WorkflowRecord[]): SystemOverview | null {
  const record = systemContextOf(records);
  return record ? { record, journey: mainJourneyOf(records) } : null;
}

/** The facts the overview states, as core counted them in the design's graph. */
export function overviewFacts(g: SystemGraph, t: Copy): OverviewFact[] {
  const f = g.facts;
  return [
    { label: t("workflows.overview.users"), value: t(f.people.length === 1 ? "workflows.overview.roles.one" : "workflows.overview.roles.many", { n: f.people.length }), rows: f.people },
    {
      label: t("workflows.overview.externals"),
      value: f.namedBoundaries > 1 ? t("workflows.overview.externalsIn", { n: f.externals, b: f.namedBoundaries }) : String(f.externals),
      rows: f.boundaries,
    },
  ];
}

/** Where the overview's one line about the system came from. */
type DescriptionSource = "project" | "purpose" | "summary";

export interface SystemDescription {
  text: string;
  source: DescriptionSource;
}

/** A text's first sentence: up to its first full stop, question or exclamation mark followed by a space. */
function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^([\s\S]+?[.!?…])(?:\s|$)/u.exec(t);
  return (m?.[1] ?? t).trim();
}

/**
 * What the system is, in one line: the project's description; else the in-scope system's stated
 * purpose in its system-context design; else the first sentence of that design's summary, which records
 * how the design was drawn and so is only shown to a viewer who cannot write a description instead.
 */
export function describeSystem(projectDocument: unknown, o: SystemOverview, graph: SystemGraph | null): SystemDescription | null {
  const project = projectDescriptionOf(projectDocument);
  if (project) return { text: project, source: "project" };
  const purpose = graph?.focal?.purpose;
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
