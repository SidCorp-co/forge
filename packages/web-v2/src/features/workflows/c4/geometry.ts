import type { TemplateEdgeKind } from "@forge/contracts/workflow-templates";
import { DASH, edgeHue } from "../canvas/style";
import type { C4Kind, C4Relation } from "./model";

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether a design states an outside system's integration as settled, read from its label (`integrationOf`). */
export type IntegrationState = "confirmed" | "unconfirmed";

/** One system a folded boundary stands for, as its hover card lists it. */
export interface GroupMember {
  id: string;
  name: string;
  owner: string | null;
  state: IntegrationState | null;
  /** The words the state was read from, for the badge's tooltip. */
  mark: string | null;
}

/** A box on a C4 diagram. `step` is the design step it draws; the system box on Context draws none. */
export interface DBox extends Rect {
  id: string;
  kind: C4Kind | "focal";
  /** The element's type, shown above its title where no column heading already says it. */
  kicker: string | null;
  lines: string[];
  tip: string;
  step: string | null;
  /** An outside system's integration state, drawn as a dashed outline when it is not confirmed. */
  state?: IntegrationState | null;
  /** A folded boundary: the systems (or people) it stands for. */
  members?: GroupMember[];
}

export interface DLine {
  id: string;
  d: string;
  /** The drawn path as a polyline, for hit tests and the crossing checks. */
  samples: Pt[];
  label: string;
  tip: string;
  at: Pt;
  anchor: "start" | "middle" | "end";
  dash: string | undefined;
  colour: string;
  arrowStart: boolean;
  arrowEnd: boolean;
  /** The design line a click opens; a merged Context line opens its first. */
  edge: string | null;
  /** Every design line the drawn line stands for, so selecting one lights it. */
  edges: string[];
  ends: [string, string];
}

export interface DCaption {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  tone: "heading" | "group";
  tip?: string;
  maxWidth: number;
  /** A boundary the viewer opened, which this caption folds back. */
  folds?: string;
}

export interface Diagram {
  level: "context" | "containers";
  width: number;
  height: number;
  boxes: DBox[];
  lines: DLine[];
  captions: DCaption[];
  boundary: (Rect & { title: string; tip: string }) | null;
}

/**
 * Every type size a C4 diagram draws, in diagram units: one unit is one CSS pixel at 100% zoom. The
 * renderer reads them from here, so the smallest one is the floor `MIN_FONT_PX` is held against.
 */
export const FONT = {
  title: 13.5,
  focal: 15,
  label: 12,
  kicker: 12,
  heading: 13,
  group: 12,
  boundary: 14,
} as const;

/** No text on a diagram is drawn smaller than this on screen at fit; a diagram that cannot fit summarises more instead. */
export const MIN_FONT_PX = 12;

/** The smallest type a diagram draws, in its own units. */
export const SMALLEST_FONT = Math.min(...Object.values(FONT));

/** The lowest zoom at which the smallest type still reads at `MIN_FONT_PX`. */
export const MIN_READABLE_ZOOM = MIN_FONT_PX / SMALLEST_FONT;

/** A string's drawn width in the UI face, estimated: Vietnamese with its diacritics runs close to 0.56em. */
export const textWidth = (s: string, size: number) => s.length * size * 0.56;

/** Words wrapped into at most `lines` lines inside `width`, the last one cut with an ellipsis. */
export function wrap(text: string, width: number, size: number, lines = 2): string[] {
  const words = text.trim().split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size) <= width || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  const used = out.join(" ").split(/\s+/).length;
  if (used < words.length || textWidth(out[out.length - 1] ?? "", size) > width) {
    let last = out[out.length - 1] ?? "";
    while (last.length > 1 && textWidth(`${last}…`, size) > width) last = last.slice(0, -1);
    out[out.length - 1] = `${last.trimEnd()}…`;
  }
  return out;
}

/** An SVG path and its polyline, built together so what is tested is what is drawn. */
export class PathBuilder {
  private d: string[] = [];
  private at: Pt = { x: 0, y: 0 };
  readonly samples: Pt[] = [];

  move(p: Pt) {
    this.d.push(`M${r(p.x)},${r(p.y)}`);
    this.samples.push(p);
    this.at = p;
    return this;
  }

  line(p: Pt) {
    this.d.push(`L${r(p.x)},${r(p.y)}`);
    this.samples.push(p);
    this.at = p;
    return this;
  }

  /** A curve leaving and arriving level, as a line between two columns does. */
  level(p: Pt) {
    const a = this.at;
    const dx = (p.x - a.x) / 2;
    const c1 = { x: a.x + dx, y: a.y };
    const c2 = { x: p.x - dx, y: p.y };
    this.d.push(`C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p.x)},${r(p.y)}`);
    for (let i = 1; i <= 16; i++) this.samples.push(bezier(a, c1, c2, p, i / 16));
    this.at = p;
    return this;
  }

  /** An orthogonal run through these corners, each corner rounded. */
  corners(points: Pt[], radius = 8) {
    for (let i = 0; i < points.length; i++) {
      const c = points[i] as Pt;
      const n = points[i + 1];
      if (!n) {
        this.line(c);
        break;
      }
      const p = this.at;
      const d1 = Math.hypot(c.x - p.x, c.y - p.y);
      const d2 = Math.hypot(n.x - c.x, n.y - c.y);
      const k = Math.min(radius, d1 / 2, d2 / 2);
      if (!d1 || !d2 || !k) {
        this.line(c);
        continue;
      }
      const a = { x: c.x + ((p.x - c.x) * k) / d1, y: c.y + ((p.y - c.y) * k) / d1 };
      const b = { x: c.x + ((n.x - c.x) * k) / d2, y: c.y + ((n.y - c.y) * k) / d2 };
      this.line(a);
      this.d.push(`Q${r(c.x)},${r(c.y)} ${r(b.x)},${r(b.y)}`);
      this.samples.push(b);
      this.at = b;
    }
    return this;
  }

  get path() {
    return this.d.join(" ");
  }
}

const r = (n: number) => Math.round(n * 10) / 10;

export function bezier(a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

/** The point halfway along a polyline, where its label sits. */
export function midpoint(samples: readonly Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < samples.length; i++) total += dist(samples[i - 1] as Pt, samples[i] as Pt);
  let left = total / 2;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as Pt;
    const b = samples[i] as Pt;
    const d = dist(a, b);
    if (d >= left && d > 0) return { x: a.x + ((b.x - a.x) * left) / d, y: a.y + ((b.y - a.y) * left) / d };
    left -= d;
  }
  return samples[0] ?? { x: 0, y: 0 };
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** How a relation's line is drawn: its kind's dash and colour, or a plain line when it merges lines of different kinds. */
export function lineStyle(r: Pick<C4Relation, "src">): { dash: string | undefined; colour: string } {
  const kinds = new Map<string, TemplateEdgeKind>(r.src.map((e) => [e.kind.id, e.kind]));
  const only = kinds.size === 1 ? [...kinds.values()][0] : undefined;
  return only ? { dash: DASH[only.line], colour: edgeHue(only) } : { dash: undefined, colour: "var(--wf-edge)" };
}
