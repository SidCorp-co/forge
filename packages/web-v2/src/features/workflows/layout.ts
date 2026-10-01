import type { WorkflowKind, WorkflowStep } from "./types";

export interface PlacedStep {
  step: WorkflowStep;
  x: number;
  y: number;
}

export interface Edge {
  from: string;
  to: string;
  d: string;
}

export interface Layout {
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
  steps: PlacedStep[];
  edges: Edge[];
}

function depths(steps: readonly WorkflowStep[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const s = byId.get(id);
    if (!s || seen.has(id)) return 0;
    const next = new Set(seen).add(id);
    const d = s.after.length === 0 ? 0 : 1 + Math.max(...s.after.map((a) => depth(a, next)));
    memo.set(id, d);
    return d;
  };
  for (const s of steps) depth(s.id, new Set());
  return memo;
}

export function layoutOf(steps: readonly WorkflowStep[], kind: WorkflowKind): Layout {
  const vertical = kind === "state";
  const nodeW = vertical ? 132 : 140;
  const nodeH = vertical ? 38 : 58;
  const gapX = vertical ? 22 : 34;
  const gapY = vertical ? 32 : 26;
  const d = depths(steps);
  const cols = new Map<number, WorkflowStep[]>();
  for (const s of steps) {
    const k = d.get(s.id) ?? 0;
    cols.set(k, [...(cols.get(k) ?? []), s]);
  }
  const levels = [...cols.keys()].sort((a, b) => a - b);
  const widest = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const width = vertical ? widest * nodeW + (widest - 1) * gapX : levels.length * nodeW + (levels.length - 1) * gapX;
  const height = vertical ? levels.length * nodeH + (levels.length - 1) * gapY : widest * nodeH + (widest - 1) * gapY;
  const pos = new Map<string, { x: number; y: number }>();
  for (const level of levels) {
    const col = cols.get(level) ?? [];
    if (vertical) {
      const rowW = col.length * nodeW + (col.length - 1) * gapX;
      col.forEach((s, i) => {
        pos.set(s.id, { x: (width - rowW) / 2 + i * (nodeW + gapX), y: level * (nodeH + gapY) });
      });
    } else {
      const colH = col.length * nodeH + (col.length - 1) * gapY;
      col.forEach((s, i) => {
        pos.set(s.id, { x: level * (nodeW + gapX), y: (height - colH) / 2 + i * (nodeH + gapY) });
      });
    }
  }
  const edges: Edge[] = steps.flatMap((s) =>
    s.after.flatMap((a) => {
      const p = pos.get(a);
      const q = pos.get(s.id);
      if (!p || !q) return [];
      if (vertical) {
        const x1 = p.x + nodeW / 2;
        const y1 = p.y + nodeH;
        const x2 = q.x + nodeW / 2;
        const y2 = q.y - 2;
        const my = (y1 + y2) / 2;
        return [{ from: a, to: s.id, d: `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}` }];
      }
      const x1 = p.x + nodeW;
      const y1 = p.y + nodeH / 2;
      const x2 = q.x - 2;
      const y2 = q.y + nodeH / 2;
      const mx = (x1 + x2) / 2;
      return [{ from: a, to: s.id, d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}` }];
    }),
  );
  return {
    width,
    height,
    nodeW,
    nodeH,
    steps: steps.map((s) => ({ step: s, ...(pos.get(s.id) ?? { x: 0, y: 0 }) })),
    edges,
  };
}

export function walkedOf(steps: readonly WorkflowStep[]): { walked: number; total: number } {
  return {
    walked: steps.filter((s) => s.evidence?.coverage.reading === "walked").length,
    total: steps.length,
  };
}
