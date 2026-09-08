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

/**
 * The characters in `rendered` whose script the model brought in by itself.
 * Empty means storable. Each offending code point is reported once, so a
 * caller can name them in a log line without dumping the whole string.
 */
// cm:why the allowance is per-CHARACTER, not per-script: a source naming `北京` licenses `北京` and no other Han character. Stricter than ISS-962's wording ("the English source's own non-Latin characters") on purpose — for machine output an invented glyph of an already-present script is the same defect as an invented script, and the per-character form needs no Unicode script table to compute the source's side.
export function foreignScriptChars(rendered: string, source: string): string[] {
  const licensed = new Set<string>();
  for (const ch of source) if (!ALWAYS_STORABLE.test(ch)) licensed.add(ch);

  const offending = new Set<string>();
  for (const ch of rendered) {
    if (ALWAYS_STORABLE.test(ch) || licensed.has(ch)) continue;
    offending.add(ch);
  }
  return [...offending];
}

/** `foreignScriptChars` as the yes/no the write paths branch on. */
export function storableAgainstSource(rendered: string, source: string): boolean {
  return foreignScriptChars(rendered, source).length === 0;
}
