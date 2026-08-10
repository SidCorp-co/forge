// Line-level diff for the skill-update review screen.
//
// A reviewer is deciding whether a body is safe to publish to every runner on
// the project, so the screen has to show what actually changed — a character
// count would let a rewrite pass as an edit.

import type { DiffLine } from "./types";

/**
 * Longest-common-subsequence line diff. Bodies are skill markdown (a few
 * hundred lines at most), so the O(n·m) table is fine and keeps the result
 * exact — no heuristics that could hide a removed line.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "removed", text: a[i++] });
  while (j < m) out.push({ kind: "added", text: b[j++] });
  return out;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  return {
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
  };
}

/**
 * Collapse long unchanged stretches to `context` lines either side of a change,
 * so a 400-line body with one edited paragraph does not bury it.
 * Returns segments; a `null` entry marks an elided gap.
 */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind === "same") return;
    for (let k = idx - context; k <= idx + context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });
  const out: (DiffLine | null)[] = [];
  let elided = false;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) {
      out.push(l);
      elided = false;
    } else if (!elided) {
      out.push(null);
      elided = true;
    }
  });
  return out;
}
