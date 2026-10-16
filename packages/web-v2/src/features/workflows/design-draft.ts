// A design as its editor holds it: the version-2 document core stores, read through the template it is
// drawn in. The template names each step type's and line kind's owed fields; the editor offers those
// and keeps every other field as written, so a field an agent set (a wireframe, a mapping, a ref) is
// never lost by a save from here. Whether the document holds is core's to say (`workflows/rules.ts`);
// nothing here re-checks it, and a refusal comes back on the step or line its path names.

import type { NodeRequirableField, WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { WORKFLOW_V2_SCHEMA_ID } from "@forge/contracts/workflows";
import type { DesignDocument, WorkflowBody, WorkflowEdgeContract, WorkflowStep } from "./types";

/** How the editor writes one owed field: a line, one entry per line, rows of when and result, a closed choice, or kept as written. */
export type FieldShape = "text" | "list" | "conditions" | "variant" | "persona" | "kept";

const LIST_FIELDS = new Set(["inputs", "outputs", "tests", "permissions", "dataShown", "actions", "payload", "values"]);
/** Fields an agent draws with the files or maps they name; the editor shows they are owed and keeps what is there. */
const KEPT_FIELDS = new Set(["wireframe", "mapping"]);

export const UI_VARIANTS = ["empty", "loading", "error", "success", "partial"] as const;

export function shapeOf(field: string): FieldShape {
  if (KEPT_FIELDS.has(field)) return "kept";
  if (LIST_FIELDS.has(field)) return "list";
  if (field === "conditions") return "conditions";
  if (field === "variant") return "variant";
  if (field === "persona") return "persona";
  return "text";
}

/** Words folded to an identifier's letters: lower case, marks dropped, everything else a hyphen. */
function identifierOf(words: string): string {
  return words
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\u0111/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** A flow slug from a title, as core takes one (`^[a-z][a-z0-9-]{0,62}$`). */
export function flowOf(title: string): string {
  const id = identifierOf(title);
  return /^[a-z]/.test(id) ? id : `flow-${id}`.replace(/-$/, "");
}

/** A step id from a label, unique among `taken`, as core takes one (`^[a-z][a-z0-9_-]{0,62}$`). */
export function stepIdOf(label: string, taken: ReadonlySet<string>): string {
  const id = identifierOf(label);
  const base = /^[a-z]/.test(id) ? id : `step-${id}`.replace(/-$/, "");
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** A design drawn in a state-machine template is a state design; every other is a flow. */
export const kindOf = (template: WorkflowTemplate): WorkflowBody["kind"] => (template.layout.family === "state-machine" ? "state" : "flow");

/** The fields a step of `type` owes beyond its label, which every step is given. */
export function nodeFieldsOf(template: WorkflowTemplate | null, type: string | undefined): NodeRequirableField[] {
  return (template?.nodeTypes.find((n) => n.id === type)?.required ?? []).filter((f) => f !== "label");
}

/**
 * Fields a step may carry whatever its type owes, offered beside the owed ones: who owns it and by
 * when, what it is for, and the rules and checks that draw its exceptions — what the approval
 * checklist reads for roles and exceptions (`workflows/design-checklist-record.ts`).
 */
const STEP_OPTIONAL = ["owner", "sla", "purpose", "conditions", "tests"] as const;

/** The optional fields of a step of `type`: those its type does not already owe. */
export const stepOptionalOf = (owed: readonly string[]) => STEP_OPTIONAL.filter((f) => !owed.includes(f));

/** Fields a line may carry whatever its kind owes: the condition it runs on and what happens when it fails. */
const LINE_OPTIONAL = ["condition", "onFailure"] as const;

export const lineOptionalOf = (owed: readonly string[]) => LINE_OPTIONAL.filter((f) => !owed.includes(f));

/** The fields a line of `kind` owes beyond its label. */
export function edgeFieldsOf(template: WorkflowTemplate | null, kind: string | undefined): string[] {
  return (template?.edgeKinds.find((k) => k.id === kind)?.required ?? []).filter((f) => f !== "label");
}

/** The type a new step takes: the template's default, else its first entry type, else its first. */
export function firstTypeOf(template: WorkflowTemplate): string {
  return template.defaultNodeType ?? template.nodeTypes.find((n) => n.entry)?.id ?? template.nodeTypes[0]?.id ?? "STEP";
}

/** The type a step added after the first takes: the template's default, else its first type no entry is. */
export function nextTypeOf(template: WorkflowTemplate): string {
  return template.defaultNodeType ?? template.nodeTypes.find((n) => !n.entry)?.id ?? firstTypeOf(template);
}

/** The bands a step may sit in: the template's own, or the lanes the design declares. */
export function bandsOf(template: WorkflowTemplate | null, doc: Pick<DesignDocument, "lanes">): { id: string; label: string }[] {
  if (!template) return [];
  if (template.lanes.from === "template") return template.lanes.bands.map((b) => ({ id: b.id, label: b.label }));
  if (template.lanes.from === "design") return doc.lanes ?? [];
  return [];
}

/** Whether the design names its own lanes (a swimlane's actors, a sequence's systems). */
export const lanesFromDesign = (template: WorkflowTemplate | null) => template?.lanes.from === "design";

/** Whether the design declares the personas its screens are for. */
export const declaresPersonas = (template: WorkflowTemplate | null) => template?.rules.includes("personas-declared") === true;

/** The stored document as a write sends it back: the stamps core owns left out, everything else as held. */
export function documentOf(doc: WorkflowBody & { id?: string; createdAt?: string; updatedAt?: string }): DesignDocument {
  const { id: _id, createdAt: _c, updatedAt: _u, ...body } = doc;
  return { ...body, $schema: WORKFLOW_V2_SCHEMA_ID, version: 2 };
}

/** The first step a new design is created with: what happens there, and its node as written (its type, label and owed fields). */
export interface FirstStep {
  does: string;
  node: NonNullable<WorkflowStep["node"]>;
}

/**
 * What a new design starts from: the template's own example, whose shape its template's rules already
 * hold, or — for a template with none — one step written in the dialog. An example's step leaves behind
 * what points outside the design (`refs` to the example's other designs, `wireframe` boards the example
 * names but no project holds): a template that owes them refuses by name, and an agent draws them.
 */
export type DesignStart = { example: WorkflowBody } | { first: FirstStep };

const EXAMPLE_ONLY = ["refs", "wireframe"] as const;

function exampleStep(s: WorkflowStep): WorkflowStep {
  if (!s.node) return s;
  const node = { ...s.node } as Record<string, unknown>;
  for (const k of EXAMPLE_ONLY) delete node[k];
  return { ...s, node: node as unknown as WorkflowStep["node"] };
}

/** A new design's whole document: its head, the template it is drawn in, and the steps it starts from. */
export function newDesign(input: { projectId: string; flow: string; title: string; summary: string; template: WorkflowTemplate; start: DesignStart }): DesignDocument {
  const { template, start } = input;
  const head = {
    $schema: WORKFLOW_V2_SCHEMA_ID,
    version: 2 as const,
    project: input.projectId,
    flow: input.flow,
    title: input.title.trim(),
    summary: input.summary.trim(),
    template: { id: template.id, version: template.version },
    writtenBy: {},
  };
  if ("example" in start) {
    const { kind, steps, edges, lanes, personas } = start.example;
    return { ...head, kind, steps: steps.map(exampleStep), ...(edges ? { edges } : {}), ...(lanes ? { lanes } : {}), ...(personas ? { personas } : {}) };
  }
  const { first } = start;
  return {
    ...head,
    kind: kindOf(template),
    steps: [{ id: stepIdOf(first.node.label ?? "", new Set()), does: first.does.trim(), after: [], node: { ...first.node, ...(first.node.label ? { label: first.node.label.trim() } : {}) } }],
  };
}

/** A step appended after the last one, its id taken from its label. */
export function addedStep(doc: DesignDocument, label: string, type: string): DesignDocument {
  const id = stepIdOf(label, new Set(doc.steps.map((s) => s.id)));
  const last = doc.steps[doc.steps.length - 1];
  const step: WorkflowStep = { id, does: label.trim(), after: last ? [last.id] : [], node: { type, label: label.trim() } };
  return { ...doc, steps: [...doc.steps, step] };
}

/** A step taken out with every line that names it: no `after` and no edge is left dangling. */
export function removedStep(doc: DesignDocument, id: string): DesignDocument {
  return {
    ...doc,
    steps: doc.steps.filter((s) => s.id !== id).map((s) => (s.after.includes(id) ? { ...s, after: s.after.filter((a) => a !== id) } : s)),
    ...(doc.edges ? { edges: doc.edges.filter((e) => e.from !== id && e.to !== id) } : {}),
  };
}

export const withStep = (doc: DesignDocument, i: number, step: WorkflowStep): DesignDocument => ({ ...doc, steps: doc.steps.map((s, j) => (j === i ? step : s)) });

export const withEdge = (doc: DesignDocument, i: number, edge: WorkflowEdgeContract): DesignDocument => ({ ...doc, edges: (doc.edges ?? []).map((e, j) => (j === i ? edge : e)) });

export const removedEdge = (doc: DesignDocument, i: number): DesignDocument => ({ ...doc, edges: (doc.edges ?? []).filter((_, j) => j !== i) });

/** A line from the first step to the last, for the reader to point where it goes. */
export function addedEdge(doc: DesignDocument): DesignDocument {
  const from = doc.steps[0]?.id ?? "";
  const to = doc.steps[doc.steps.length - 1]?.id ?? from;
  return { ...doc, edges: [...(doc.edges ?? []), { from, to }] };
}

/** A node field's value set, or taken away when empty, so an emptied field is not sent as an empty one. */
export function withNodeField(step: WorkflowStep, field: string, value: unknown): WorkflowStep {
  const node = { ...(step.node ?? { type: "STEP" }) } as Record<string, unknown>;
  const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) delete node[field];
  else node[field] = value;
  return { ...step, node: node as unknown as WorkflowStep["node"] };
}

/** An edge field's value set, or taken away when empty. */
export function withEdgeField(edge: WorkflowEdgeContract, field: string, value: unknown): WorkflowEdgeContract {
  const next = { ...edge } as Record<string, unknown>;
  const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) delete next[field];
  else next[field] = value;
  return next as unknown as WorkflowEdgeContract;
}

/** One entry per line, blank lines dropped. */
export const linesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Core's refusals under one step or line (`/steps/2`, `/edges/0`), read by the field each names. */
export interface ItemRefusals {
  /** Whether core refused anything under the item. */
  any: boolean;
  /** Core's words for what it refused at `field` (`does`, `node/label`) or under it. */
  at: (field: string) => string | undefined;
  /** Core's words for what it refused under the item at none of `shown`, the fields drawn. */
  rest: (shown: readonly string[]) => string | undefined;
}

const joined = (rows: readonly { detail: string }[]) => (rows.length ? rows.map((r) => r.detail).join(" ") : undefined);

export function refusalsUnder(refusals: readonly { path: string; detail: string }[], prefix: string): ItemRefusals {
  const owns = (path: string, at: string) => path === at || path.startsWith(`${at}/`);
  const under = refusals.filter((r) => owns(r.path, prefix));
  return {
    any: under.length > 0,
    at: (field) => joined(under.filter((r) => owns(r.path, `${prefix}/${field}`))),
    rest: (shown) => joined(under.filter((r) => !shown.some((f) => owns(r.path, `${prefix}/${f}`)))),
  };
}
