import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { type Canvas, type CanvasEdge, purposeOf, readCanvas, titleOf } from "../canvas/model";
import type { WorkflowBody, WorkflowLane } from "../types";
import type { IntegrationState } from "./geometry";
import type { C4Group } from "./summary";

export const SYSTEM_CONTEXT_TEMPLATE = "system-context";

export type C4Kind = "person" | "system" | "container";

/** One element of a system-context design, as a C4 diagram places it. */
export interface C4Element {
  id: string;
  kind: C4Kind;
  title: string;
  purpose: string;
  owner: string | null;
  /** The design's boundary the element sits in. */
  lane: string | null;
}

/** The software system the design is about: one box on Context, a boundary of its parts on Containers. */
export interface C4Focal {
  title: string;
  tip: string;
  /** What the system is, in the design's own words: the in-scope system's `purpose`; empty when it states none. */
  purpose: string;
  lane: string | null;
  /** The containers (and any system the design draws inside the same boundary) that make it up. */
  parts: C4Element[];
}

/** A relationship between two Context elements: the design's lines between them, lifted and merged. */
export interface C4Relation {
  id: string;
  from: string;
  to: string;
  /** Lines run the other way too, so both ends get an arrowhead. */
  both: boolean;
  src: CanvasEdge[];
}

export interface C4Model {
  canvas: Canvas;
  focal: C4Focal | null;
  people: C4Element[];
  externals: C4Element[];
  lanes: readonly WorkflowLane[];
  /** Context's relations; an end inside the system reads as `FOCAL`. */
  relations: C4Relation[];
  /** The boundaries folded into one element each (`summarise`), by the element id that stands for them. */
  groups?: ReadonlyMap<string, C4Group>;
}

export const FOCAL = "__system";

type Doc = Pick<WorkflowBody, "title" | "summary" | "kind" | "steps" | "edges" | "flow" | "lanes">;

function kindOf(type: string): C4Kind {
  if (type === "PERSON") return "person";
  if (type === "CONTAINER") return "container";
  return "system";
}

/**
 * The system in scope is the boundary that holds the containers (C4: containers only ever live inside
 * the system being described). A design with no container has no boundary to read, so its most
 * connected system stands alone as the one in scope.
 */
function focalOf(elements: C4Element[], lanes: readonly WorkflowLane[], c: Canvas): C4Focal | null {
  const containers = elements.filter((e) => e.kind === "container");
  if (containers.length > 0) {
    const count = new Map<string | null, number>();
    for (const e of containers) count.set(e.lane, (count.get(e.lane) ?? 0) + 1);
    const lane = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const parts = elements.filter((e) => e.kind !== "person" && (e.lane === lane || (e.kind === "container" && e.lane === null)));
    const named = lanes.find((l) => l.id === lane);
    const system = parts.find((p) => p.kind === "system");
    return {
      title: named?.label ?? system?.title ?? "This system",
      tip: named?.tooltip ?? system?.purpose ?? "",
      purpose: "",
      lane,
      parts,
    };
  }
  const systems = elements.filter((e) => e.kind === "system");
  if (systems.length === 0) return null;
  const degree = (id: string) => c.edges.filter((e) => e.from === id || e.to === id).length;
  const top = [...systems].sort((a, b) => degree(b.id) - degree(a.id))[0] as C4Element;
  return { title: top.title, tip: top.purpose, purpose: "", lane: top.lane, parts: [top] };
}

export function readC4(doc: Doc, template: WorkflowTemplate | null): C4Model {
  const canvas = readCanvas(doc, template);
  const lanes = doc.lanes ?? [];
  const elements: C4Element[] = doc.steps.map((s) => ({
    id: s.id,
    kind: kindOf(canvas.typeOf(s.id).id),
    title: titleOf(s),
    purpose: purposeOf(s),
    owner: s.node?.owner ?? null,
    lane: s.node?.band ?? null,
  }));
  const focal = focalOf(elements, lanes, canvas);
  if (focal) {
    // Only a stated `purpose` says what the system is; `purposeOf` falls back to what the step does.
    const system = focal.parts.find((p) => p.kind === "system");
    focal.purpose = doc.steps.find((s) => s.id === system?.id)?.node?.purpose?.trim() ?? "";
  }
  const inside = new Set(focal?.parts.map((p) => p.id) ?? []);
  const end = (id: string) => (inside.has(id) ? FOCAL : id);
  const relations: C4Relation[] = [];
  const byPair = new Map<string, C4Relation>();
  for (const e of canvas.edges) {
    const from = end(e.from);
    const to = end(e.to);
    if (from === to) continue;
    const key = [from, to].sort().join("|");
    const seen = byPair.get(key);
    if (seen) {
      seen.src.push(e);
      if (seen.from !== from) seen.both = true;
      continue;
    }
    const r: C4Relation = { id: `rel:${key}`, from, to, both: false, src: [e] };
    byPair.set(key, r);
    relations.push(r);
  }
  return {
    canvas,
    focal,
    people: elements.filter((e) => e.kind === "person"),
    externals: elements.filter((e) => e.kind !== "person" && !inside.has(e.id)),
    lanes,
    relations,
  };
}

/** A line's words on a diagram: the clause before its first aside, cut at a word inside `max` characters. */
export function shortLabel(text: string, max = 30): string {
  const t = text.trim();
  const clause = t.split(/\s*[(,;:–—]\s*/)[0]?.trim() ?? t;
  const base = clause.length >= 6 ? clause : t;
  if (base.length <= max) return base;
  const cut = base.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The full words a relation stands for, for its tooltip: each design line on its own row, with its protocol. */
export function relationTip(r: C4Relation, name: (id: string) => string): string {
  return r.src
    .map((e) => {
      const words = e.contract?.label ?? e.contract?.condition ?? e.kind.label;
      const over = e.contract?.protocol ? ` [${e.contract.protocol}]` : "";
      return `${name(e.from)} → ${name(e.to)}: ${words}${over}`;
    })
    .join("\n");
}

export const relationWords = (r: C4Relation) => r.src[0]?.contract?.label ?? r.src[0]?.contract?.condition ?? "";

// cm:why the schema has no field for whether an outside system's integration is settled, so designs
// say it in a closing aside on the label, in the project's own language (HOP's are Vietnamese). Only
// an aside naming it unconfirmed or proposed counts; the badge's tooltip quotes the words.
const OPEN_MARK = /\s*\(([^()]*?(?:chưa xác nhận|đề xuất|unconfirmed|not confirmed|proposed|to be confirmed)[^()]*)\)\s*$/iu; // i18n-allow: the words HOP's designs mark an open integration with

/** An outside system's name without its unconfirmed aside, and the state that aside states. */
export function integrationOf(title: string): { name: string; state: IntegrationState; mark: string | null } {
  const m = OPEN_MARK.exec(title);
  if (!m) return { name: title.trim(), state: "confirmed", mark: null };
  return { name: title.slice(0, m.index).trim() || title.trim(), state: "unconfirmed", mark: m[1]?.trim() ?? null };
}
