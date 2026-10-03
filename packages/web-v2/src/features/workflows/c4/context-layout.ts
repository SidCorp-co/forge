import { titleOf } from "../canvas/model";
import { type C4Element, type C4Model, type C4Relation, FOCAL, relationTip, relationWords, shortLabel } from "./model";
import {
  type DBox,
  type DCaption,
  type Diagram,
  type DLine,
  LABEL_SIZE,
  lineStyle,
  midpoint,
  PathBuilder,
  type Pt,
  textWidth,
  TITLE_SIZE,
  wrap,
} from "./geometry";

const BOX_W = 196;
const BOX_H = 50;
const PITCH = 66;
const GAP = 196;
const FOCAL_W = 224;
const FOCAL_MIN_H = 132;
const CAPTION = 20;
const HEAD = 34;
const BAND_GAP = 26;
const BRACKET = 14;

/**
 * Where a row sits: 0 above the system, 1 beside it, 2 below it. A person who talks to an outside
 * system directly, and that system, go above or below the system box so the line between them
 * passes it instead of crossing it.
 */
type Band = 0 | 1 | 2;

interface Row {
  el: C4Element;
  band: Band;
  y: number;
}

/**
 * C4 level 1 in three columns, people | the system | external systems, laid out by rule rather than by
 * a solver, so the same design always draws the same picture:
 *
 * - every line between a column and the system leaves its box in the order of the other end, so the
 *   lines into one side of the system never cross;
 * - a person-to-outside-system line runs above or below the system box, its two ends placed at the top
 *   or bottom of their columns;
 * - a line between two people (or two outside systems) is a bracket on the column's outer side.
 */
export function layoutContext(m: C4Model): Diagram | null {
  const focal = m.focal;
  if (!focal) return null;
  const people = new Set(m.people.map((p) => p.id));
  const outside = new Set(m.externals.map((x) => x.id));
  const order = new Map(m.canvas.doc.steps.map((s, i) => [s.id, i]));
  const laneOrder = new Map(m.lanes.map((l, i) => [l.id, i]));
  const touching = (id: string) => m.relations.filter((r) => r.from === id || r.to === id);
  const otherEnd = (r: C4Relation, id: string) => (r.from === id ? r.to : r.from);
  const usesSystem = (id: string) => touching(id).some((r) => otherEnd(r, id) === FOCAL);
  const across = m.relations.filter((r) => (people.has(r.from) && outside.has(r.to)) || (outside.has(r.from) && people.has(r.to)));
  const crossesTo = (id: string) => across.filter((r) => r.from === id || r.to === id).map((r) => otherEnd(r, id));

  const personBand = new Map<string, Band>();
  for (const p of m.people) {
    const direct = crossesTo(p.id).length > 0;
    if (usesSystem(p.id)) personBand.set(p.id, direct ? 0 : 1);
    else personBand.set(p.id, touching(p.id).length > 0 ? 2 : 1);
  }
  const outsideBand = new Map<string, Band>();
  for (const x of m.externals) {
    const reached = crossesTo(x.id).map((p) => personBand.get(p));
    outsideBand.set(x.id, reached.includes(2) ? 2 : reached.includes(0) ? 0 : 1);
  }
  // An outside system only another outside system talks to sits beside that one.
  for (let pass = 0; pass < 2; pass++) {
    for (const x of m.externals) {
      if (usesSystem(x.id) || crossesTo(x.id).length > 0) continue;
      const near = touching(x.id).map((r) => otherEnd(r, x.id)).filter((id) => outside.has(id));
      const band = near.map((id) => outsideBand.get(id) ?? 1).sort()[0];
      if (band !== undefined) outsideBand.set(x.id, band);
    }
  }

  const byOrder = (a: C4Element, b: C4Element) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  const left: Row[] = [...m.people]
    .sort((a, b) => (personBand.get(a.id) ?? 1) - (personBand.get(b.id) ?? 1) || byOrder(a, b))
    .map((el) => ({ el, band: personBand.get(el.id) ?? 1, y: 0 }));
  const lane = (el: C4Element) => (el.lane === null ? Number.MAX_SAFE_INTEGER : (laneOrder.get(el.lane) ?? Number.MAX_SAFE_INTEGER - 1));
  const right: Row[] = [...m.externals]
    .sort((a, b) => (outsideBand.get(a.id) ?? 1) - (outsideBand.get(b.id) ?? 1) || lane(a) - lane(b) || byOrder(a, b))
    .map((el) => ({ el, band: outsideBand.get(el.id) ?? 1, y: 0 }));

  // A group heading above each run of outside systems that share a boundary.
  const headed = new Set<string>();
  right.forEach((row, i) => {
    const prev = right[i - 1];
    if (row.el.lane && (!prev || prev.el.lane !== row.el.lane || prev.band !== row.band)) headed.add(row.el.id);
  });

  // Each band's height is the taller of its two columns, so the system box spans the middle band on both sides.
  const extent = (rows: Row[], b: Band, heads: boolean) =>
    rows.filter((r) => r.band === b).reduce((h, r) => h + PITCH + (heads && headed.has(r.el.id) ? CAPTION : 0), 0);
  const bandH = ([0, 1, 2] as Band[]).map((b) => Math.max(extent(left, b, false), extent(right, b, true)));
  bandH[1] = Math.max(bandH[1] ?? 0, FOCAL_MIN_H + 18);
  const bandTop: number[] = [];
  let y = HEAD;
  for (const b of [0, 1, 2] as Band[]) {
    bandTop[b] = y;
    if ((bandH[b] ?? 0) > 0) y += (bandH[b] ?? 0) + (b < 2 ? BAND_GAP : 0);
  }
  const place = (rows: Row[], heads: boolean) => {
    for (const b of [0, 1, 2] as Band[]) {
      const inBand = rows.filter((r) => r.band === b);
      const h = extent(rows, b, heads);
      // Top band hugs the top, bottom band the bottom, so a line passing the system stays clear of it.
      let at = (bandTop[b] ?? 0) + (b === 0 ? 0 : b === 1 ? ((bandH[b] ?? 0) - h) / 2 : (bandH[b] ?? 0) - h);
      for (const r of inBand) {
        if (heads && headed.has(r.el.id)) at += CAPTION;
        r.y = at;
        at += PITCH;
      }
    }
  };
  place(left, false);
  place(right, true);

  // Brackets between two people (left) or two outside systems (right), nested so none crosses another.
  const brackets = (rows: Row[], kinds: Set<string>) => {
    const rels = m.relations.filter((r) => kinds.has(r.from) && kinds.has(r.to));
    const yOf = new Map(rows.map((r) => [r.el.id, r.y + BOX_H / 2]));
    const span = (r: C4Relation) => {
      const a = yOf.get(r.from) ?? 0;
      const b = yOf.get(r.to) ?? 0;
      return [Math.min(a, b), Math.max(a, b)] as const;
    };
    const levels: (readonly [number, number])[][] = [];
    const level = new Map<string, number>();
    for (const r of [...rels].sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]))) {
      const [a, b] = span(r);
      let k = 0;
      while (levels[k]?.some(([c, d]) => a <= d + 4 && c <= b + 4)) k++;
      levels[k] = [...(levels[k] ?? []), [a, b]];
      level.set(r.id, k);
    }
    return { rels, level, depth: levels.length };
  };
  const pp = brackets(left, people);
  const xx = brackets(right, outside);
  const tag = (r: C4Relation) => shortLabel(relationWords(r), 18) + (r.src.length > 1 ? ` +${r.src.length - 1}` : "");
  const bracketRoom = (b: ReturnType<typeof brackets>) =>
    b.depth === 0 ? 8 : 16 + BRACKET * b.depth + Math.max(...b.rels.map((r) => textWidth(tag(r), LABEL_SIZE))) + 8;
  const leftRoom = bracketRoom(pp);
  const rightRoom = bracketRoom(xx);

  const x0 = leftRoom;
  const fx = x0 + BOX_W + GAP;
  const x2 = fx + FOCAL_W + GAP;
  const width = x2 + BOX_W + rightRoom;
  const height = y + 8;
  const fTop = (bandTop[1] ?? HEAD) + 9;
  const fBox = { x: fx, y: fTop, w: FOCAL_W, h: (bandH[1] ?? FOCAL_MIN_H) - 18 };

  const rowOf = new Map([...left, ...right].map((r) => [r.el.id, r]));
  const boxOf = (id: string) => {
    if (id === FOCAL) return fBox;
    const row = rowOf.get(id);
    return { x: people.has(id) ? x0 : x2, y: row?.y ?? 0, w: BOX_W, h: BOX_H };
  };
  const centreY = (id: string) => {
    const b = boxOf(id);
    return b.y + b.h / 2;
  };

  // Ports: every line attached to a box side, spread along it in the order of where the line goes next.
  type Side = "l" | "r";
  const attach = new Map<string, { line: string; key: number }[]>();
  const at = (box: string, side: Side, line: string, key: number) => {
    const k = `${box}:${side}`;
    attach.set(k, [...(attach.get(k) ?? []), { line, key }]);
  };
  const isAcross = (r: C4Relation) => across.includes(r);
  const passBelow = (r: C4Relation) => {
    const p = people.has(r.from) ? r.from : r.to;
    const x = people.has(r.from) ? r.to : r.from;
    return (personBand.get(p) ?? 1) === 2 || ((personBand.get(p) ?? 1) === 1 && (outsideBand.get(x) ?? 1) === 2);
  };
  for (const r of m.relations) {
    if (r.from === FOCAL || r.to === FOCAL) {
      const end = r.from === FOCAL ? r.to : r.from;
      const side: Side = people.has(end) ? "l" : "r";
      at(FOCAL, side, r.id, centreY(end));
      at(end, side === "l" ? "r" : "l", r.id, centreY(FOCAL));
      continue;
    }
    if (isAcross(r)) {
      const key = passBelow(r) ? 1e6 : -1e6;
      const p = people.has(r.from) ? r.from : r.to;
      const x = people.has(r.from) ? r.to : r.from;
      at(p, "r", r.id, key + centreY(x));
      at(x, "l", r.id, key + centreY(p));
      continue;
    }
    const b = people.has(r.from) ? pp : xx;
    const k = b.level.get(r.id) ?? 0;
    const side: Side = people.has(r.from) ? "l" : "r";
    for (const [self, other] of [
      [r.from, r.to],
      [r.to, r.from],
    ] as const) {
      const above = centreY(other) < centreY(self);
      at(self, side, r.id, above ? k : 1000 - k);
    }
  }
  const port = new Map<string, Pt>();
  for (const [k, list] of attach) {
    const [box, side] = k.split(":") as [string, Side];
    const b = boxOf(box);
    const sorted = [...list].sort((p, q) => p.key - q.key);
    const n = sorted.length;
    const inset = box === FOCAL ? 24 : 12;
    const spanH = b.h - 2 * inset;
    const step = n > 1 ? Math.min(box === FOCAL ? 40 : 12, spanH / (n - 1)) : 0;
    sorted.forEach((a, i) => {
      port.set(`${a.line}@${box}`, { x: side === "l" ? b.x : b.x + b.w, y: b.y + b.h / 2 + (i - (n - 1) / 2) * step });
    });
  }
  const portOf = (r: C4Relation, box: string) => port.get(`${r.id}@${box}`) ?? { x: 0, y: centreY(box) };

  const name = (id: string) => {
    const s = m.canvas.steps.get(id);
    return s ? titleOf(s) : id;
  };
  const lines: DLine[] = [];
  for (const r of m.relations) {
    const pb = new PathBuilder();
    let label: Pt;
    let anchor: DLine["anchor"] = "middle";
    let words = shortLabel(relationWords(r), 30);
    // The line is drawn from its left end; an arrowhead goes on whichever end the relation points to.
    let a = r.from;
    let b = r.to;
    const leftOf = (id: string) => (people.has(id) ? 0 : id === FOCAL ? 1 : 2);
    if (leftOf(a) > leftOf(b) || (leftOf(a) === leftOf(b) && centreY(a) > centreY(b))) [a, b] = [b, a];
    if (a === FOCAL || b === FOCAL) {
      pb.move(portOf(r, a)).level(portOf(r, b));
      label = midpoint(pb.samples);
    } else if (isAcross(r)) {
      const p = portOf(r, a);
      const q = portOf(r, b);
      const below = passBelow(r);
      // Level from the person's side, so lines from several people into one system stay apart, and clear of the system box.
      const lane = below ? Math.max(p.y, fBox.y + fBox.h + 16) : Math.min(p.y, fBox.y - 16);
      pb.move(p).level({ x: fBox.x - 14, y: lane }).line({ x: fBox.x + fBox.w + 14, y: lane }).level(q);
      label = { x: fBox.x + fBox.w / 2, y: lane };
      words = shortLabel(relationWords(r), 36);
    } else {
      const onLeft = people.has(a);
      const k = (onLeft ? pp : xx).level.get(r.id) ?? 0;
      const p = portOf(r, a);
      const q = portOf(r, b);
      const bx = onLeft ? x0 - 16 - BRACKET * k : x2 + BOX_W + 16 + BRACKET * k;
      pb.move(p).corners([
        { x: bx, y: p.y },
        { x: bx, y: q.y },
        { x: q.x, y: q.y },
      ]);
      label = { x: onLeft ? bx - 6 : bx + 6, y: (p.y + q.y) / 2 };
      anchor = onLeft ? "end" : "start";
      words = shortLabel(relationWords(r), 18);
    }
    const style = lineStyle(r);
    lines.push({
      id: r.id,
      d: pb.path,
      samples: pb.samples,
      label: words + (r.src.length > 1 ? ` +${r.src.length - 1}` : ""),
      tip: relationTip(r, name),
      at: label,
      anchor,
      ...style,
      arrowEnd: r.both || r.to === b,
      arrowStart: r.both || r.to === a,
      edge: r.src[0]?.id ?? null,
      ends: [r.from, r.to],
    });
  }

  const box = (row: Row, x: number): DBox => ({
    id: row.el.id,
    x,
    y: row.y,
    w: BOX_W,
    h: BOX_H,
    kind: row.el.kind,
    kicker: null,
    lines: wrap(row.el.title, BOX_W - 24, TITLE_SIZE),
    tip: [row.el.title, row.el.owner ? `Owner: ${row.el.owner}` : null, row.el.purpose].filter(Boolean).join("\n"),
    step: row.el.id,
  });
  const parts = focal.parts.length;
  const boxes: DBox[] = [
    ...left.map((r) => box(r, x0)),
    {
      id: FOCAL,
      ...fBox,
      kind: "focal",
      kicker: `${parts} ${parts === 1 ? "container" : "containers"}`,
      lines: wrap(focal.title, FOCAL_W - 32, 15, 3),
      tip: [focal.title, focal.tip].filter(Boolean).join("\n"),
      step: null,
    },
    ...right.map((r) => box(r, x2)),
  ];
  const laneLabel = new Map(m.lanes.map((l) => [l.id, l]));
  const captions: DCaption[] = [
    ...(left.length ? [{ text: "People", x: x0, y: HEAD - 14, anchor: "start" as const, tone: "heading" as const, maxWidth: BOX_W }] : []),
    { text: "Software system", x: fx, y: HEAD - 14, anchor: "start", tone: "heading", maxWidth: FOCAL_W },
    ...(right.length ? [{ text: "External systems", x: x2, y: HEAD - 14, anchor: "start" as const, tone: "heading" as const, maxWidth: BOX_W }] : []),
    ...right
      .filter((r) => headed.has(r.el.id))
      .map((r) => {
        const l = laneLabel.get(r.el.lane ?? "");
        return { text: l?.label ?? "", tip: l?.tooltip, x: x2, y: r.y - 7, anchor: "start" as const, tone: "group" as const, maxWidth: BOX_W + rightRoom - 8 };
      }),
  ];
  return { level: "context", width, height, boxes, lines, captions, boundary: null };
}
