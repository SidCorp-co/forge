import type { ElkPoint } from "elkjs/lib/elk-api";
import { layoutGraph, type Placed, type Size } from "@/lib/graph/layout";
import type { View } from "./view";

export function layoutView(input: {
  view: View;
  sizes: ReadonlyMap<string, Size>;
  labels: ReadonlyMap<string, string>;
  /** Each node's band row, top to bottom; absent, the graph is not banded. */
  partition: ((key: string) => number) | null;
  direction: "down" | "right";
}): Promise<Placed> {
  const { view, sizes, labels, partition, direction } = input;
  return layoutGraph({
    direction,
    partitioned: partition !== null,
    nodes: view.nodes.map((n) => ({
      id: n.key,
      width: sizes.get(n.key)?.width ?? 250,
      height: sizes.get(n.key)?.height ?? 60,
      ...(partition ? { partition: partition(n.key) } : {}),
    })),
    edges: view.edges
      .filter((e) => e.src.every((s) => s.kind.direction === "forward"))
      .map((e) => ({
        id: e.key,
        from: e.from,
        to: e.to,
        label: labels.get(e.key),
        // A merged line's label carries its first line's words, wider than a card gap; at its tail it
        // leaves each layer centred on one axis (hop-layout.test.ts).
        labelPlacement: e.merged ? "TAIL" : "CENTER",
      })),
  });
}

/** A return line: out of the later card's right side, along the right of the whole graph, into the earlier card. */
export function returnPath(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
  rightEdge: number,
): { d: string; label: ElkPoint } {
  const sx = from.x + from.width;
  const sy = from.y + from.height / 2;
  const ex = to.x + to.width + 6;
  const ey = to.y + to.height / 2;
  const x = rightEdge;
  const up = sy > ey;
  const bend = Math.min(60, Math.abs(sy - ey) / 2);
  const d = up
    ? `M${sx},${sy} C${x + 10},${sy} ${x},${sy - bend * 0.4} ${x},${sy - bend} L${x},${ey + bend} C${x},${ey + bend * 0.4} ${x + 10},${ey} ${ex},${ey}`
    : `M${sx},${sy} C${x + 10},${sy} ${x},${sy + bend * 0.4} ${x},${sy + bend} L${x},${ey - bend} C${x},${ey - bend * 0.4} ${x + 10},${ey} ${ex},${ey}`;
  return { d, label: { x, y: (sy + ey) / 2 } };
}
