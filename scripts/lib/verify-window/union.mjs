/**
 * Both sides of a declared union path, where the member only ADDED lines to the common base: each
 * block it inserted goes in beside the combination's, right after the base line it follows. A
 * member that removed or rewrote a base line is refused rather than kept twice, because keeping both
 * versions of an edited line publishes the old one and the new one side by side.
 */

/**
 * Where two ranges of line ids meet on a shortest edit script: Myers' middle snake, found by
 * walking forward from the start and backward from the end until the two paths overlap. Called
 * only once both ranges are non-empty and differ at both ends, so the point is strictly inside.
 */
function middleSnake(x, xLo, xHi, y, yLo, yHi) {
  const n = xHi - xLo;
  const m = yHi - yLo;
  const max = Math.ceil((n + m) / 2);
  const off = max + 1;
  const size = 2 * max + 3;
  const fwd = new Int32Array(size).fill(-1);
  const rev = new Int32Array(size).fill(-1);
  fwd[off + 1] = 0;
  rev[off + 1] = 0;
  const delta = n - m;
  const odd = delta % 2 !== 0;
  let [fStart, fEnd, rStart, rEnd] = [0, 0, 0, 0];
  for (let d = 0; d <= max; d++) {
    for (let k = -d + fStart; k <= d - fEnd; k += 2) {
      const i = off + k;
      let a = k === -d || (k !== d && fwd[i - 1] < fwd[i + 1]) ? fwd[i + 1] : fwd[i - 1] + 1;
      let b = a - k;
      while (a < n && b < m && x[xLo + a] === y[yLo + b]) {
        a++;
        b++;
      }
      fwd[i] = a;
      if (a > n) fEnd += 2;
      else if (b > m) fStart += 2;
      else if (odd) {
        const j = off + delta - k;
        if (j >= 0 && j < size && rev[j] !== -1 && a >= n - rev[j]) return [xLo + a, yLo + b];
      }
    }
    for (let k = -d + rStart; k <= d - rEnd; k += 2) {
      const i = off + k;
      let a = k === -d || (k !== d && rev[i - 1] < rev[i + 1]) ? rev[i + 1] : rev[i - 1] + 1;
      let b = a - k;
      while (a < n && b < m && x[xHi - 1 - a] === y[yHi - 1 - b]) {
        a++;
        b++;
      }
      rev[i] = a;
      if (a > n) rEnd += 2;
      else if (b > m) rStart += 2;
      else if (!odd) {
        const j = off + delta - k;
        if (j >= 0 && j < size && fwd[j] !== -1 && fwd[j] >= n - a) {
          return [xLo + fwd[j], yLo + fwd[j] - (j - off)];
        }
      }
    }
  }
  throw new Error(
    `no middle snake between ${n} and ${m} lines, which a shortest edit script always has`,
  );
}

/** Record in `map` the matches of one longest common subsequence of the two ranges. */
function align(x, xLo, xHi, y, yLo, yHi, map) {
  let [a0, a1, b0, b1] = [xLo, xHi, yLo, yHi];
  while (a0 < a1 && b0 < b1 && x[a0] === y[b0]) map[a0++] = b0++;
  while (a0 < a1 && b0 < b1 && x[a1 - 1] === y[b1 - 1]) {
    a1--;
    b1--;
    map[a1] = b1;
  }
  if (a0 === a1 || b0 === b1) return;
  const [sa, sb] = middleSnake(x, a0, a1, y, b0, b1);
  align(x, a0, sa, y, b0, sb, map);
  align(x, sa, a1, y, sb, b1, map);
}

/**
 * For each line of `a`, the line of `b` a longest common subsequence matches it to, or -1. The
 * work grows with how much the two differ rather than with the product of their lengths, and the
 * memory with their lengths, so no file is too large to union.
 */
export function matchLines(a, b) {
  const ids = new Map();
  const id = (line) => {
    if (!ids.has(line)) ids.set(line, ids.size);
    return ids.get(line);
  };
  const x = Int32Array.from(a, id);
  const y = Int32Array.from(b, id);
  const map = new Array(a.length).fill(-1);
  align(x, 0, x.length, y, 0, y.length, map);
  return map;
}

function linesOf(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** The blocks `t` inserts into the base, each after the base line it follows (-1 for the top). */
function insertedBlocks(t, inTheirs) {
  const baseAt = new Map(inTheirs.map((j, i) => [j, i]));
  const blocks = [];
  let after = -1;
  let lines = [];
  for (let j = 0; j < t.length; j++) {
    if (!baseAt.has(j)) {
      lines.push(t[j]);
      continue;
    }
    if (lines.length > 0) blocks.push({ after, lines });
    lines = [];
    after = baseAt.get(j);
  }
  if (lines.length > 0) blocks.push({ after, lines });
  return blocks;
}

/**
 * @param {{ base: string, ours: string, theirs: string, path: string }} sides
 * @returns {{ text: string } | { refusal: string }}
 */
export function unionInsertions({ base, ours, theirs, path }) {
  const [b, o, t] = [linesOf(base), linesOf(ours), linesOf(theirs)];
  const inTheirs = matchLines(b, t);
  const gone = inTheirs.indexOf(-1);
  if (gone !== -1) {
    return {
      refusal: `${path}: this member removes or rewrites line ${gone + 1} (\`${b[gone].slice(0, 80)}\`), and a union path only takes additions`,
    };
  }
  const inOurs = matchLines(b, o);
  const insertAfter = new Map();
  for (const block of insertedBlocks(t, inTheirs)) {
    const at = block.after === -1 ? -1 : inOurs[block.after];
    if (at === -1 && block.after !== -1) {
      return {
        refusal: `${path}: this member adds after line ${block.after + 1} (\`${b[block.after].slice(0, 80)}\`), which the combination removed or rewrote`,
      };
    }
    insertAfter.set(at, [...(insertAfter.get(at) ?? []), ...block.lines]);
  }
  const out = [...(insertAfter.get(-1) ?? [])];
  for (const [k, line] of o.entries()) out.push(line, ...(insertAfter.get(k) ?? []));
  return { text: out.length === 0 ? '' : `${out.join('\n')}\n` };
}
