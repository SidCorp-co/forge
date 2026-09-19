const ALWAYS_STORABLE = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

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
