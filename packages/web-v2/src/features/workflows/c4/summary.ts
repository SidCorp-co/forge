import { layoutContext } from "./context-layout";
import { type Diagram, MIN_FONT_PX, SMALLEST_FONT } from "./geometry";
import type { C4Element, C4Model, C4Relation } from "./model";

/**
 * How much of a Context diagram is folded, least first:
 *
 * - `full` draws every person and every outside system;
 * - `boundaries` folds each outside boundary holding two or more systems into one element with a count,
 *   and the people the same way once there are more than `PEOPLE_AT_A_GLANCE` of them;
 * - `people` folds the people by boundary as well, however few;
 * - `columns` folds each side into one element.
 */
export type SummaryLevel = "full" | "boundaries" | "people" | "columns";
export const SUMMARY_LEVELS: readonly SummaryLevel[] = ["full", "boundaries", "people", "columns"];

export const PEOPLE_AT_A_GLANCE = 4;

/** A boundary folded into one element: what it is called and who or what it stands for. */
export interface C4Group {
  id: string;
  side: "people" | "externals";
  lane: string | null;
  label: string;
  tip: string;
  members: C4Element[];
}

type Fold = "none" | "lanes" | "all";

function foldsAt(level: SummaryLevel, m: C4Model): { people: Fold; externals: Fold } {
  if (level === "full") return { people: "none", externals: "none" };
  if (level === "boundaries") return { people: m.people.length > PEOPLE_AT_A_GLANCE ? "lanes" : "none", externals: "lanes" };
  if (level === "people") return { people: "lanes", externals: "lanes" };
  return { people: "all", externals: "all" };
}

export const groupId = (side: C4Group["side"], lane: string | null) => `group:${side}:${lane ?? "*"}`;

/**
 * The Context model with its boundaries folded as `level` says, except those the viewer opened. Every
 * relation is lifted to the elements that now stand for its ends and merged once per pair, the way the
 * Context lifts a container's lines to the system; a line inside one folded boundary is not drawn.
 */
export function summarise(m: C4Model, level: SummaryLevel, open: ReadonlySet<string> = new Set()): C4Model {
  const folds = foldsAt(level, m);
  if (folds.people === "none" && folds.externals === "none") return m;
  const laneOf = new Map(m.lanes.map((l) => [l.id, l]));
  const groups = new Map<string, C4Group>();
  const standsFor = new Map<string, string>();

  const fold = (side: C4Group["side"], els: C4Element[], how: Fold): C4Element[] => {
    if (how === "none") return els;
    const buckets = new Map<string, C4Element[]>();
    for (const el of els) {
      if (how === "lanes" && el.lane === null) continue;
      const key = how === "all" ? groupId(side, null) : groupId(side, el.lane);
      buckets.set(key, [...(buckets.get(key) ?? []), el]);
    }
    const out: C4Element[] = [];
    const placed = new Set<string>();
    for (const el of els) {
      const key = how === "all" ? groupId(side, null) : el.lane === null ? null : groupId(side, el.lane);
      const members = key ? (buckets.get(key) ?? []) : [];
      if (!key || members.length < 2 || open.has(key)) {
        out.push(el);
        continue;
      }
      for (const x of members) standsFor.set(x.id, key);
      if (placed.has(key)) continue;
      placed.add(key);
      const lane = how === "all" ? null : el.lane;
      const named = lane ? laneOf.get(lane) : undefined;
      const label = named?.label ?? (side === "people" ? "People" : "External systems");
      groups.set(key, { id: key, side, lane, label, tip: named?.tooltip ?? "", members });
      out.push({ id: key, kind: side === "people" ? "person" : "system", title: label, purpose: named?.tooltip ?? "", owner: null, lane });
    }
    return out;
  };

  const people = fold("people", m.people, folds.people);
  const externals = fold("externals", m.externals, folds.externals);
  const end = (id: string) => standsFor.get(id) ?? id;
  const relations: C4Relation[] = [];
  const byPair = new Map<string, C4Relation>();
  for (const r of m.relations) {
    const from = end(r.from);
    const to = end(r.to);
    if (from === to) continue;
    const key = [from, to].sort().join("|");
    const seen = byPair.get(key);
    if (seen) {
      seen.src.push(...r.src);
      if (seen.from !== from || r.both) seen.both = true;
      continue;
    }
    const lifted: C4Relation = { id: `rel:${key}`, from, to, both: r.both, src: [...r.src] };
    byPair.set(key, lifted);
    relations.push(lifted);
  }
  return { ...m, people, externals, relations, groups };
}

export interface Fit {
  level: SummaryLevel;
  diagram: Diagram;
  /** The zoom the diagram opens at: as large as fits the box, never below `MIN_FONT_PX` for its smallest type. */
  zoom: number;
  /** False when even the most folded level is wider or taller than the box at that floor: the canvas pans. */
  fits: boolean;
}

/**
 * The least folded Context that fits the box with its smallest type at `MIN_FONT_PX` or larger. A
 * diagram that cannot fit is folded further, never drawn smaller; past `columns` it opens at the floor
 * and the canvas pans.
 */
export function fitContext(
  m: C4Model,
  box: { width: number; height: number },
  options: { maxZoom?: number; from?: SummaryLevel; open?: ReadonlySet<string> } = {},
): Fit | null {
  const maxZoom = options.maxZoom ?? 1.25;
  const floor = MIN_FONT_PX / SMALLEST_FONT;
  const levels = SUMMARY_LEVELS.slice(SUMMARY_LEVELS.indexOf(options.from ?? "full"));
  let last: Fit | null = null;
  for (const level of levels) {
    const diagram = layoutContext(summarise(m, level, options.open));
    if (!diagram) return null;
    const zoom = Math.min(box.width / diagram.width, box.height / diagram.height, maxZoom);
    if (zoom >= floor) return { level, diagram, zoom, fits: true };
    last = { level, diagram, zoom: floor, fits: false };
  }
  return last;
}
