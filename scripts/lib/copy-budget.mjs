// The copy budget (REQ-43 BC-1, BC-2): every English string in the web copy files is short.
// Pure functions over already-read strings, so a test can plant a string without a file.

/** A `{name}` or `{{name}}` placeholder; it is one word whatever it expands to. */
const PLACEHOLDER = /\{\{[^}]*\}\}|\{[^}]*\}/g;

/** The words of one copy string: whitespace-separated tokens, each placeholder one word. */
export function wordsOf(text) {
  return text.replace(PLACEHOLDER, 'X').split(/\s+/).filter(Boolean).length;
}

/** A key is a refusal or a confirmation when any of its dot-separated segments matches `segments`. */
export function isRefusalKey(key, segments) {
  return key.split('.').some((segment) => segments.test(segment));
}

/**
 * Every over-budget string of `entries` (`{file, key, text}`), keyed `file::key`:
 * `{file, key, words, budget}`. English only: a key's other languages are translations of it.
 */
export function overBudget(entries, { budget, refusalBudget, refusalSegments }) {
  const over = new Map();
  for (const { file, key, text } of entries) {
    const words = wordsOf(text);
    const allowed = isRefusalKey(key, refusalSegments) ? refusalBudget : budget;
    if (words > allowed) over.set(`${file}::${key}`, { file, key, words, budget: allowed });
  }
  return over;
}

/** `{file: {key: words}}` of the baseline document, flattened to `file::key` → words. */
export function frozen(doc) {
  const out = new Map();
  for (const [file, keys] of Object.entries(doc?.files ?? {})) {
    for (const [key, words] of Object.entries(keys)) out.set(`${file}::${key}`, words);
  }
  return out;
}

/**
 * What is wrong between the strings over budget now and the baseline: each fault names file, key,
 * the word count and the budget. The baseline only shrinks, so a fixed string that is still listed
 * is a fault too — an entry nothing trims would let the next over-budget string take its place.
 */
export function faults(over, baseline) {
  const out = [];
  for (const [id, o] of over) {
    const was = baseline.get(id);
    if (was === undefined) {
      out.push(`${o.file} · ${o.key}: ${o.words} words, budget ${o.budget}; a new string over budget is refused`);
    } else if (o.words > was) {
      out.push(`${o.file} · ${o.key}: grew from ${was} to ${o.words} words, budget ${o.budget}`);
    } else if (o.words < was) {
      out.push(`${o.file} · ${o.key}: now ${o.words} words (baseline ${was}), budget ${o.budget}; trim the baseline entry`);
    }
  }
  for (const [id, was] of baseline) {
    if (over.has(id)) continue;
    const [file, key] = id.split('::');
    out.push(`${file} · ${key}: within budget now (baseline ${was}) or gone; remove its baseline entry`);
  }
  return out;
}

/** The baseline document for `over`, entries sorted so a diff shows only what changed. */
export function baselineOf(over) {
  const files = {};
  for (const o of [...over.values()].sort((a, b) => `${a.file}::${a.key}`.localeCompare(`${b.file}::${b.key}`))) {
    (files[o.file] ??= {})[o.key] = o.words;
  }
  return { files };
}
