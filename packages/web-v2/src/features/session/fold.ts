
import { type Copy, productCopy } from "@/lib/i18n/product-copy";
import type { RenderBlock } from "./types";

/** A block that stays visible, under the index it holds in the unfolded turn. */
export interface FoldKeptBlock {
  kind: "block";
  block: RenderBlock;
  /** Its index in the turn's own `blocks`, so the renderer keys and reads it unchanged. */
  index: number;
}

/** The one row standing in for everything this turn collapsed. */
export interface FoldRow {
  kind: "fold";
  label: string;
}

export interface FoldedTurn {
  rows: (FoldKeptBlock | FoldRow)[];
}

/** What the row says it is holding. */
function foldLabel(tools: number, pauses: number, t: Copy): string {
  const parts: string[] = [];
  if (tools > 0) parts.push(tools === 1 ? t("sessions.fold.toolOne") : t("sessions.fold.toolMany", { n: tools }));
  if (pauses > 0) parts.push(pauses === 1 ? t("sessions.fold.pauseOne") : t("sessions.fold.pauseMany", { n: pauses }));
  return parts.length === 2 ? t("sessions.fold.and", { a: parts[0] as string, b: parts[1] as string }) : (parts[0] ?? "");
}

/**
 * A turn's blocks with its machinery behind one row, or `null` where there is no machinery.
 */
export function foldTurn(blocks: readonly RenderBlock[], t: Copy = productCopy()): FoldedTurn | null {
  let tools = 0;
  let pauses = 0;
  for (const b of blocks) {
    if (b.type === "tool") tools += 1;
    else if (b.type === "thinking") pauses += b.count ?? 1;
  }
  if (tools === 0 && pauses === 0) return null;

  const rows: (FoldKeptBlock | FoldRow)[] = [];
  let placed = false;
  blocks.forEach((block, index) => {
    if (block.type === "tool" || block.type === "thinking") {
      if (!placed) {
        rows.push({ kind: "fold", label: foldLabel(tools, pauses, t) });
        placed = true;
      }
      return;
    }
    rows.push({ kind: "block", block, index });
  });
  return { rows };
}
