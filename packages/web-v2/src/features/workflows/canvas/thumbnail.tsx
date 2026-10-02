import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { useMemo } from "react";
import type { WorkflowBody } from "../types";
import { readCanvas } from "./model";
import { hue, tint } from "./style";

const W = 240;
const H = 96;
const PAD = 14;

interface Dot {
  x: number;
  y: number;
  colour: string;
}

/** Each step's column: one past the deepest step it comes after. */
function depths(steps: WorkflowBody["steps"]): Map<string, number> {
  const ids = new Set(steps.map((s) => s.id));
  const at = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const held = at.get(id);
    if (held !== undefined) return held;
    if (seen.has(id)) return 0;
    seen.add(id);
    const s = steps.find((x) => x.id === id);
    const d = Math.max(-1, ...(s?.after ?? []).filter((a) => ids.has(a)).map((a) => visit(a, seen))) + 1;
    at.set(id, d);
    return d;
  };
  for (const s of steps) visit(s.id, new Set());
  return at;
}

/** A design's shape at a glance, drawn once as SVG: its bands as stripes and each step as a dot in its type's colour. */
export function WorkflowThumbnail({
  doc,
  template,
}: {
  doc: Pick<WorkflowBody, "title" | "summary" | "kind" | "steps" | "edges" | "flow">;
  template: WorkflowTemplate | null;
}) {
  const { stripes, dots } = useMemo(() => {
    const c = readCanvas(doc, template);
    const out: Dot[] = [];
    if (c.bands.length > 0) {
      const h = H / c.bands.length;
      const stripes = c.bands.map((b, i) => {
        const n = b.steps.length;
        const gap = Math.min(22, (W - 2 * PAD) / Math.max(n, 1));
        const x0 = W / 2 - ((n - 1) * gap) / 2;
        b.steps.forEach((id, j) => {
          out.push({ x: x0 + j * gap, y: i * h + h / 2, colour: c.typeOf(id).colour });
        });
        return { y: i * h, h, colour: c.typeOf(b.steps[0] ?? "").colour };
      });
      return { stripes, dots: out };
    }
    const depth = depths(doc.steps);
    const cols = Math.max(0, ...depth.values()) + 1;
    const byCol = new Map<number, string[]>();
    for (const s of doc.steps) byCol.set(depth.get(s.id) ?? 0, [...(byCol.get(depth.get(s.id) ?? 0) ?? []), s.id]);
    const dx = (W - 2 * PAD) / Math.max(cols - 1, 1);
    for (const [col, ids] of byCol) {
      const dy = Math.min(18, (H - 2 * PAD) / Math.max(ids.length, 1));
      const y0 = H / 2 - ((ids.length - 1) * dy) / 2;
      ids.forEach((id, j) => {
        out.push({ x: cols === 1 ? W / 2 : PAD + col * dx, y: y0 + j * dy, colour: c.typeOf(id).colour });
      });
    }
    return { stripes: [], dots: out };
  }, [doc, template]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-24 w-full" aria-hidden="true" data-testid="workflow-thumb">
      <rect width={W} height={H} fill="var(--bg-sunken)" />
      {stripes.map((s) => (
        <rect key={s.y} x={0} y={s.y} width={W} height={s.h} fill={tint(s.colour, 18, "var(--bg-surface)")} />
      ))}
      {dots.map((d) => (
        <circle key={`${d.x}:${d.y}`} cx={d.x} cy={d.y} r={4} fill={hue(d.colour)} />
      ))}
    </svg>
  );
}
