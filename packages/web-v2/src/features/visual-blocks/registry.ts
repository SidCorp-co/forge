import { VISUAL_BLOCK_KINDS, type VisualBlockKind, type VisualBlockOf } from "@forge/contracts/visual-blocks";
import type { ComponentType } from "react";
import { ChartBlockView } from "./chart-block";
import { FlowBlockView } from "./flow-block";
import { KpiBlockView } from "./kpi-block";
import { StatusListBlockView } from "./status-list-block";
import { TableBlockView } from "./table-block";
import { TimelineBlockView } from "./timeline-block";

export type BlockRenderer<K extends VisualBlockKind> = ComponentType<{ block: VisualBlockOf<K> }>;

/** The web side of the Block port: a renderer per kind, keyed by the contract's own ids. */
export const BLOCK_RENDERERS: { [K in VisualBlockKind]: BlockRenderer<K> } = {
  table: TableBlockView,
  kpi: KpiBlockView,
  "status-list": StatusListBlockView,
  chart: ChartBlockView,
  timeline: TimelineBlockView,
  flow: FlowBlockView,
};

/** What stands between the contract's kinds and the renderers, each problem named; empty when they agree. */
export function registryParity(kinds: readonly string[], drawn: readonly string[]): string[] {
  const known = new Set(kinds);
  const problems: string[] = [];
  for (const kind of kinds) {
    if (!drawn.includes(kind)) problems.push(`the contract kind "${kind}" has no renderer`);
  }
  for (const name of drawn) {
    if (!known.has(name)) problems.push(`the renderer "${name}" has no contract kind`);
  }
  return problems;
}

/** The registry as it stands, checked against the contract. */
export const currentParity = (): string[] => registryParity(VISUAL_BLOCK_KINDS, Object.keys(BLOCK_RENDERERS));
