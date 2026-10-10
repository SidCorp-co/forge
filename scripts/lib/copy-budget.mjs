// The copy budget (REQ-43 BC-1, BC-2, BC-4, BC-6): every English string in the web copy files is
// short, an empty state is a word or two, and no string explains. Pure functions over already-read
// strings, so a test can plant a string without a file.

/** A `{name}` or `{{name}}` placeholder; it is one word whatever it expands to. */
const PLACEHOLDER = /\{\{[^}]*\}\}|\{[^}]*\}/g;

/** The words of one copy string: whitespace-separated tokens, each placeholder one word. */
export function wordsOf(text) {
  return text.replace(PLACEHOLDER, 'X').split(/\s+/).filter(Boolean).length;
}

/** Whether any dot-separated segment of `key` matches `segments` whole. */
export function keyHasSegment(key, segments) {
  return key.split('.').some((segment) => segments.test(segment));
}

/** Whether the last dot-separated segment of `key` — the one naming the string itself — matches `segments` whole. */
export function keyEndsWith(key, segments) {
  return segments.test(key.slice(key.lastIndexOf('.') + 1));
}

/**
 * What a key is, read from its segments by the conventions the config declares, never guessed from
 * the sentence: `explain` (a string that explains a section, a button or who can see something,
 * refused at any length), `empty` (an empty state), `refusal` (a refusal or confirmation) or `copy`.
 * An explanation or an empty state is named by the key's last segment, since a namespace segment
 * such as `help` in `common.help.title` names a page, not the string; a refusal by any segment,
 * since `x.refusal.moved` names its kind in the middle. Explaining wins over the rest, so a
 * `noneHint` is refused rather than budgeted as an empty state.
 */
export function kindOf(key, { refusalSegments, emptySegments, explainSegments }) {
  if (keyEndsWith(key, explainSegments)) return 'explain';
  if (keyEndsWith(key, emptySegments)) return 'empty';
  if (keyHasSegment(key, refusalSegments)) return 'refusal';
  return 'copy';
}

/** The words a key of `kind` may hold; an explaining string may hold none. */
function allowedFor(kind, { budget, refusalBudget, emptyBudget }) {
  if (kind === 'explain') return 0;
  if (kind === 'empty') return emptyBudget;
  if (kind === 'refusal') return refusalBudget;
  return budget;
}

/**
 * Every string of `entries` (`{file, key, text}`) the budget refuses, keyed `file::key`:
 * `{file, key, kind, words, budget}`. English only: a key's other languages are translations of it.
 * A blank string is no words, so it is never refused, whatever its kind.
 */
export function overBudget(entries, cfg) {
  const over = new Map();
  for (const { file, key, text } of entries) {
    const words = wordsOf(text);
    const kind = kindOf(key, cfg);
    const allowed = allowedFor(kind, cfg);
    if (words > allowed) over.set(`${file}::${key}`, { file, key, kind, words, budget: allowed });
  }
  return over;
}

/** One refusal line per string over budget, naming file, key, its words and what its kind allows. */
export function faults(over) {
  return [...over.values()]
    .sort((a, b) => `${a.file}::${a.key}`.localeCompare(`${b.file}::${b.key}`))
    .map((o) => {
      if (o.kind === 'explain')
        return `${o.file} · ${o.key}: a string that explains a section, a button or who can see something is refused at any length; delete it, or change the control`;
      const what =
        o.kind === 'empty'
          ? 'an empty state'
          : o.kind === 'refusal'
            ? 'a refusal or confirmation'
            : 'a copy string';
      return `${o.file} · ${o.key}: ${o.words} words, budget ${o.budget} for ${what}`;
    });
}
