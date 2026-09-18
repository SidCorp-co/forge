/**
 * The mechanical check a model's prose passes before core stores it (ISS-962).
 *
 * Core does not render Vietnamese — `forge-plugin`'s `vi-natural` does, before
 * any tracker write reaches here. What core DOES do is store prose a model
 * wrote: `extraction.ts` turns an issue's comments into `memories` rows and
 * `knowledge_edges`, `consolidation.ts` rewrites and archives them, and both
 * prompts say "Preserve the original language. Do not translate." A model told
 * to keep a language it was not trained to keep is exactly the setup that put
 * the Cyrillic for "bypass" inside an otherwise Vietnamese acceptance criterion
 * on another project. Nothing here checked a character.
 *
 * The rule is source-relative, because an absolute one is wrong: refusing all
 * Cyrillic would refuse a Russian-speaking team's own words. The model is
 * allowed the scripts its input used, and nothing else.
 */

// cm:why Latin covers precomposed Vietnamese (Latin Extended Additional), Common covers digits, punctuation, symbols and emoji, and Inherited covers the combining marks an NFD spelling of the same Vietnamese word decomposes into. Dropping Inherited passes NFC and silently refuses NFD, which is the same word.
const ALWAYS_STORABLE = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

// cm:guard this list is DATA and the fallback is what makes it safe to be incomplete: a character
// belonging to no script named here is licensed per-character exactly as before, so adding a script
// can only ever relax, and omitting one can only ever keep the stricter rule. It is not a list of
// scripts we support — it is the list whose members we can name well enough to license as a whole.
const SCRIPTS = [
  'Han',
  'Hangul',
  'Hiragana',
  'Katakana',
  'Bopomofo',
  'Thai',
  'Lao',
  'Khmer',
  'Myanmar',
  'Cyrillic',
  'Greek',
  'Arabic',
  'Hebrew',
  'Devanagari',
  'Bengali',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Gujarati',
  'Gurmukhi',
  'Oriya',
  'Sinhala',
  'Georgian',
  'Armenian',
  'Ethiopic',
  'Tibetan',
  'Mongolian',
] as const;

const SCRIPT_TESTS: ReadonlyArray<readonly [string, RegExp]> = SCRIPTS.map(
  (name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')] as const,
);

/** The script this character belongs to, or null where this module cannot name one. */
function scriptOf(ch: string): string | null {
  for (const [name, re] of SCRIPT_TESTS) if (re.test(ch)) return name;
  return null;
}

/**
 * The characters in `rendered` whose script the model brought in by itself.
 * Empty means storable. Each offending code point is reported once, so a
 * caller can name them in a log line without dumping the whole string.
 */
// cm:why the allowance is per-SCRIPT where the script can be named, and per-CHARACTER where it cannot. REVERSED on 2026-09-18 from a per-character rule the original change took "on purpose" as a tightening. Measured against the defect it created: extraction produces PARAPHRASES by construction — the prompt asks for facts, not quotations — so a Chinese source naming a deploy branch licensed only the handful of characters it happened to use, and the model's four-character rewording was refused on two of them. Korean lost ten. Russian survived by accident of alphabet size: 33 letters are exhausted by a handful of comments, and Han, Hangul and Thai are not, so a CJK project's memory extraction dropped most of what it extracted with only a `logger.warn` to say so. What the reversal does NOT relax: a script absent from the source is refused whole, so Cyrillic against a Latin-only source still fails and so does the `mаster` homoglyph, which is the leak ISS-962 exists to stop.
export function foreignScriptChars(rendered: string, source: string): string[] {
  const licensedScripts = new Set<string>();
  const licensedChars = new Set<string>();
  for (const ch of source) {
    if (ALWAYS_STORABLE.test(ch)) continue;
    const script = scriptOf(ch);
    if (script) licensedScripts.add(script);
    else licensedChars.add(ch);
  }

  const offending = new Set<string>();
  for (const ch of rendered) {
    if (ALWAYS_STORABLE.test(ch) || licensedChars.has(ch)) continue;
    const script = scriptOf(ch);
    if (script && licensedScripts.has(script)) continue;
    offending.add(ch);
  }
  return [...offending];
}

/** `foreignScriptChars` as the yes/no the write paths branch on. */
export function storableAgainstSource(rendered: string, source: string): boolean {
  return foreignScriptChars(rendered, source).length === 0;
}
