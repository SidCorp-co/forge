import { VISUAL_BLOCK_KINDS, type VisualBlockKind, type VisualBlockOf } from "@forge/contracts/visual-blocks";
import type { ComponentType } from "react";
import { KpiBlockView } from "./kpi-block";
import { StatusListBlockView } from "./status-list-block";
import { TableBlockView } from "./table-block";

export type BlockRenderer<K extends VisualBlockKind> = ComponentType<{ block: VisualBlockOf<K> }>;

/** The web side of the Block port: a renderer per kind, keyed by the contract's own ids. */
export const BLOCK_RENDERERS: { [K in VisualBlockKind]?: BlockRenderer<K> } = {
  table: TableBlockView,
  kpi: KpiBlockView,
  "status-list": StatusListBlockView,
};

/**
 * Kinds the contract registers whose renderer is lane A6 of REQ-32 (chart, timeline, flow). Priced
 * amnesty: until A6 lands, a block of one of these kinds is drawn by name as unsupported, never
 * dropped; A6 moves each kind out of this list into `BLOCK_RENDERERS`, and the list ends empty.
 */
export const KINDS_NOT_DRAWN_YET: readonly VisualBlockKind[] = ["chart", "timeline", "flow"];

/** What stands between the contract's kinds and the renderers, each problem named; empty when they agree. */
export function registryParity(
  kinds: readonly string[],
  drawn: readonly string[],
  notDrawnYet: readonly string[],
): string[] {
  const known = new Set(kinds);
  const problems: string[] = [];
  for (const kind of kinds) {
    const inDrawn = drawn.includes(kind);
    const inUndrawn = notDrawnYet.includes(kind);
    if (!inDrawn && !inUndrawn) problems.push(`the contract kind "${kind}" has no renderer`);
    if (inDrawn && inUndrawn) problems.push(`the kind "${kind}" has a renderer and is also listed as not drawn yet`);
  }
  for (const name of drawn) {
    if (!known.has(name)) problems.push(`the renderer "${name}" has no contract kind`);
  }
  for (const name of notDrawnYet) {
    if (!known.has(name)) problems.push(`"${name}" is listed as not drawn yet but is no contract kind`);
  }
  return problems;
}

/** The registry as it stands, checked against the contract. */
export const currentParity = (): string[] =>
  registryParity(VISUAL_BLOCK_KINDS, Object.keys(BLOCK_RENDERERS), KINDS_NOT_DRAWN_YET);
