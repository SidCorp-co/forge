"use client";

// One level of the module tree as a map: a node per module in rollup order, wrapped four to a row, and
// the couplings core rolled up to this level between them. Line width is the coupling's weight; a
// coupling declared in both directions is drawn in the error tone.

import type { KeyboardEvent } from "react";
import { LEGEND } from "@/design";
import { cn } from "@/lib/utils/cn";
import type { ModuleLevelCoupling, ModuleRollupRow } from "../types";

const COLS = 4;
const W = 214;
const H = 84;
const GAP_X = 52;
const GAP_Y = 58;
const PAD = 14;

const keyOf = (r: ModuleRollupRow) => r.slug ?? r.id;

interface Placed {
  row: ModuleRollupRow;
  x: number;
  y: number;
}

function place(rows: readonly ModuleRollupRow[]): { placed: Placed[]; width: number; height: number } {
  const cols = Math.max(1, Math.min(COLS, rows.length));
  const placed = rows.map((row, i) => ({
    row,
    x: PAD + (i % cols) * (W + GAP_X),
    y: PAD + Math.floor(i / cols) * (H + GAP_Y),
  }));
  const lines = Math.max(1, Math.ceil(rows.length / cols));
  return { placed, width: PAD * 2 + cols * W + (cols - 1) * GAP_X, height: PAD * 2 + lines * H + (lines - 1) * GAP_Y };
}

const centre = (p: Placed): [number, number] => [p.x + W / 2, p.y + H / 2];

/** Where the line from `c` towards `o` leaves the node's box, with a small margin. */
function clip(c: [number, number], o: [number, number]): [number, number] {
  const dx = o[0] - c[0];
  const dy = o[1] - c[1];
  const s = Math.max(Math.abs(dx) / (W / 2 + 6), Math.abs(dy) / (H / 2 + 6)) || 1;
  return [c[0] + dx / s, c[1] + dy / s];
}

interface Drawn {
  c: ModuleLevelCoupling;
  d: string;
  label: [number, number];
  width: number;
}

function draw(couplings: readonly ModuleLevelCoupling[], at: Map<string, Placed>): Drawn[] {
  const max = Math.max(1, ...couplings.map((c) => c.weight));
  return couplings.flatMap((c) => {
    const a = at.get(c.aId);
    const b = at.get(c.bId);
    if (!a || !b) return [];
    const ca = centre(a);
    const cb = centre(b);
    const A = clip(ca, cb);
    const B = clip(cb, ca);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    // a line that would cross the nodes between two far ends of a row or column bows around them
    const far = (Math.abs(A[1] - B[1]) < 4 && len > W + GAP_X) || (Math.abs(A[0] - B[0]) < 4 && len > H + GAP_Y);
    const bend = far ? 30 + len * 0.08 : 12;
    const qx = (A[0] + B[0]) / 2 + (-(B[1] - A[1]) / len) * bend;
    const qy = (A[1] + B[1]) / 2 + ((B[0] - A[0]) / len) * bend;
    return [{ c, d: `M${A[0]},${A[1]} Q${qx},${qy} ${B[0]},${B[1]}`, label: [qx, qy], width: 1 + 5 * Math.sqrt(c.weight / max) }];
  });
}

function edgeTitle(c: ModuleLevelCoupling, name: (id: string) => string): string {
  const a = name(c.aId);
  const b = name(c.bId);
  const lines = [];
  if (c.declaredAToB) lines.push(`${a} → ${b}: ${c.declaredAToB} declared`);
  if (c.declaredBToA) lines.push(`${b} → ${a}: ${c.declaredBToA} declared`);
  if (c.sharedIssues) lines.push(`Issues carrying both sides: ${c.sharedIssues}`);
  return lines.join("\n");
}

export function ModuleMap({
  rows,
  couplings,
  selected,
  onSelect,
  onOpen,
}: {
  rows: readonly ModuleRollupRow[];
  couplings: readonly ModuleLevelCoupling[];
  selected: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  const { placed, width, height } = place(rows);
  const at = new Map(placed.map((p) => [p.row.id, p]));
  const edges = draw(couplings, at);
  const name = (id: string) => at.get(id)?.row.name ?? id;
  const selectedId = placed.find((p) => keyOf(p.row) === selected)?.row.id ?? null;
  const near = new Set(selectedId ? couplings.flatMap((c) => (c.aId === selectedId || c.bId === selectedId ? [c.aId, c.bId] : [])) : []);
  const onKey = (e: KeyboardEvent, key: string) => {
    if (e.key === "Enter") onOpen(key);
    else if (e.key === " ") {
      e.preventDefault();
      onSelect(key);
    }
  };

  return (
    <div className="overflow-x-auto" data-testid="module-map">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Map of ${rows.length} modules and ${couplings.length} couplings between them`}
        className="block h-auto w-full font-sans"
        style={{ minWidth: Math.min(width, 760), maxWidth: width * 1.15 }}
      >
        <g>
          {edges.map((e) => {
            const lit = !selectedId || e.c.aId === selectedId || e.c.bId === selectedId;
            return (
              <path
                key={`${e.c.aId}-${e.c.bId}`}
                d={e.d}
                fill="none"
                strokeLinecap="round"
                strokeWidth={e.width}
                stroke={e.c.twoWay ? LEGEND.err.fg : "var(--fg-subtle)"}
                opacity={lit ? 0.75 : 0.08}
                data-testid="module-map-edge"
                data-two-way={e.c.twoWay || undefined}
              >
                <title>{edgeTitle(e.c, name)}</title>
              </path>
            );
          })}
        </g>
        <g>
          {edges.map((e) => {
            const lit = !selectedId || e.c.aId === selectedId || e.c.bId === selectedId;
            return (
              <text
                key={`${e.c.aId}-${e.c.bId}`}
                x={e.label[0]}
                y={e.label[1] + 4}
                textAnchor="middle"
                className="font-mono"
                fontSize={12}
                fill="var(--fg-default)"
                stroke="var(--bg-app)"
                strokeWidth={3}
                paintOrder="stroke"
                opacity={lit ? 1 : 0}
                aria-hidden
              >
                {e.c.twoWay ? `${e.c.declaredAToB}⇄${e.c.declaredBToA}` : e.c.weight}
              </text>
            );
          })}
        </g>
        <g>
          {placed.map((p) => {
            const key = keyOf(p.row);
            const s = p.row.standing;
            const isSel = key === selected;
            const dim = selectedId !== null && !isSel && !near.has(p.row.id);
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG node has no <button> to be
              <g
                key={p.row.id}
                role="button"
                tabIndex={0}
                aria-label={`${p.row.name}: ${s.childCount} child modules, ${s.open} open issues. Enter opens it.`}
                aria-pressed={isSel}
                className={cn("cursor-pointer outline-none", dim && "opacity-35")}
                onClick={() => onSelect(key)}
                onDoubleClick={() => onOpen(key)}
                onKeyDown={(e) => onKey(e, key)}
                data-testid="module-map-node"
                data-key={key}
              >
                <rect
                  x={p.x}
                  y={p.y}
                  width={W}
                  height={H}
                  rx={3}
                  fill={isSel ? "var(--cobalt-50)" : "var(--bg-surface)"}
                  stroke={isSel ? "var(--link)" : "var(--border-default)"}
                  strokeWidth={isSel ? 1.5 : 1}
                />
                <text x={p.x + 12} y={p.y + 26} fontSize={15} fontWeight={600} fill="var(--fg-default)">
                  {p.row.name}
                </text>
                <text x={p.x + 12} y={p.y + 48} fontSize={12.5} fill="var(--fg-muted)">
                  {s.childCount ? `${s.childCount} child modules` : "No child modules"}
                </text>
                <text x={p.x + 12} y={p.y + 67} fontSize={12.5} fill="var(--fg-muted)">
                  Open {s.open} · Requirements {s.requirements.length}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
