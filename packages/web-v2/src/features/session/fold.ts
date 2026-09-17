// What a settled turn above the newest one shows, and what it tucks behind one row (ISS-1083).
//
// The decision this implements is the owner's: collapse, but only OLDER turns. The newest settled
// turn reads exactly as it did the moment it finished — a reader who just watched an answer arrive
// must not have it rearrange itself under them — and every turn above it folds its machinery to one
// row that opens back.
//
// cm:guard the rule is about ORDER as much as about counting: the row goes where the FIRST
// collapsed block was, and every block that stays keeps its position around it. A fold that
// gathered the prose and pushed the row to the end would rewrite the turn's answer, which is a
// worse defect than the wall of cards it replaces.

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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the row says it is holding. */
// cm:why the label counts rather than names: a row reading `Read, Grep, Grep, forge_issues_list` is
// the wall of cards again in one line, and the count is the only part a reader scanning history
// acts on — it tells them whether there is anything behind the row worth opening.
function foldLabel(tools: number, pauses: number): string {
  const parts: string[] = [];
  if (tools > 0) parts.push(plural(tools, "tool call", "tool calls"));
  if (pauses > 0) parts.push(plural(pauses, "pause", "pauses"));
  return parts.join(" and ");
}

/**
 * A turn's blocks with its machinery behind one row, or `null` where there is no machinery.
 */
// cm:guard `null` rather than a fold holding nothing, so a turn whose whole answer is prose is
// drawn by the path it has always been drawn by and this file cannot change how it reads.
export function foldTurn(blocks: readonly RenderBlock[]): FoldedTurn | null {
  let tools = 0;
  let pauses = 0;
  for (const b of blocks) {
    if (b.type === "tool") tools += 1;
    // cm:guard a thinking block's own `count` is how many times the model paused, not how many
    // blocks there are: the Claude Code derive folds a whole turn's pauses into ONE block carrying
    // `thinkingCount`, and `ThinkingLine` reads it back as "Thought 3 times". Counting blocks here
    // said "1 pause" over a turn whose line said it thought three times, which is the same number
    // disagreeing with itself two rows apart (caught by `conversation-fold.test.tsx`).
    else if (b.type === "thinking") pauses += b.count ?? 1;
  }
  if (tools === 0 && pauses === 0) return null;

  const rows: (FoldKeptBlock | FoldRow)[] = [];
  let placed = false;
  blocks.forEach((block, index) => {
    if (block.type === "tool" || block.type === "thinking") {
      if (!placed) {
        rows.push({ kind: "fold", label: foldLabel(tools, pauses) });
        placed = true;
      }
      return;
    }
    rows.push({ kind: "block", block, index });
  });
  return { rows };
}
