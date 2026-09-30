/**
 * Both sides of a declared union path, where the member only ADDED lines to the common base: each
 * block it inserted goes in beside the combination's, right after the base line it follows. A
 * member that removed or rewrote a base line is refused rather than kept twice, because keeping both
 * versions of an edited line publishes the old one and the new one side by side.
 */

const MAX_CELLS = 25_000_000;

/** For each line of `a`, the line of `b` a longest common subsequence matches it to, or -1. */
function matchLines(a, b) {
  const width = b.length + 1;
  const len = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      len[i * width + j] =
        a[i] === b[j]
          ? len[(i + 1) * width + j + 1] + 1
          : Math.max(len[(i + 1) * width + j], len[i * width + j + 1]);
    }
  }
  const map = new Array(a.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      map[i] = j;
      i++;
      j++;
    } else if (len[(i + 1) * width + j] >= len[i * width + j + 1]) i++;
    else j++;
  }
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
  if ((b.length + 1) * (Math.max(o.length, t.length) + 1) > MAX_CELLS) {
    return { refusal: `${path} is too large to union line by line here` };
  }
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
  return { text: `${out.join('\n')}\n` };
}
