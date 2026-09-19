/**
 * Whether two pieces of prose say the same thing, measured rather than read: text stated twice
 * has two authorities, and the pair diverges the first time someone corrects only the copy they
 * found — silently, because each still reads as correct. A Jaccard index over content words
 * decides it, above a `floor` of words the two must share before the index is computed at all,
 * which is what keeps it quiet. A clean result is a floor on quality, never a proof of absence.
 */

export const SENTENCE_SPLIT = /(?<=[.!?:])\s+|\n\n/;
export const CONTENT_WORD = /[a-z][a-z-]{3,}/g;

// Every second sentence of technical prose has these: they inflate a comparison, separating none.
export const STOP_WORDS = new Set(
  (
    "that this with from into than then what when which there these those your yours have has " +
    "been being does will would should must never always only also rather because before after " +
    "not and the for are its"
  ).split(" "),
);

export const DEFAULT_OVERLAP_THRESHOLD = 0.34;
export const DEFAULT_OVERLAP_FLOOR = 5;
export const DEFAULT_MIN_SENTENCE_LENGTH = 40;

export function splitSentences(text, minLength = DEFAULT_MIN_SENTENCE_LENGTH) {
  return text
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= minLength);
}

export function contentWords(sentence) {
  const words = sentence.toLowerCase().match(CONTENT_WORD) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
}

/** The index, or null when the two share too little for it to mean anything. */
export function overlap(a, b, floor = DEFAULT_OVERLAP_FLOOR) {
  if (a.size < floor || b.size < floor) return null;
  const shared = [...a].filter((word) => b.has(word));
  if (shared.length < floor) return null;
  return shared.length / new Set([...a, ...b]).size;
}

/** Units are `[label, sentence]`, label being whatever the caller needs back — a path, an AST
 *  node. Returns `[score, a, b]` worst first, each unordered pair once. */
export function findOverlaps(
  units,
  { threshold = DEFAULT_OVERLAP_THRESHOLD, floor = DEFAULT_OVERLAP_FLOOR } = {},
) {
  const words = units.map((unit) => contentWords(unit[1]));
  const hits = [];
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      if (units[i][1] === units[j][1] && units[i][0] === units[j][0]) continue;
      const score = overlap(words[i], words[j], floor);
      if (score !== null && score >= threshold) hits.push([score, units[i], units[j]]);
    }
  }
  return hits.sort((x, y) => y[0] - x[0]);
}

export function findOverlapsAgainst(
  incoming,
  existing,
  { threshold = DEFAULT_OVERLAP_THRESHOLD, floor = DEFAULT_OVERLAP_FLOOR } = {},
) {
  const theirs = existing.map((unit) => contentWords(unit[1]));
  const hits = [];
  for (const unit of incoming) {
    const mine = contentWords(unit[1]);
    for (let j = 0; j < existing.length; j += 1) {
      if (unit[0] === existing[j][0] && unit[1] === existing[j][1]) continue;
      const score = overlap(mine, theirs[j], floor);
      if (score !== null && score >= threshold) hits.push([score, unit, existing[j]]);
    }
  }
  return hits.sort((x, y) => y[0] - x[0]);
}
