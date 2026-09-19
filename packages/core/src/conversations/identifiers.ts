/**
 * The shapes that count as naming something outside the sentence.
 */
const PATTERNS: readonly RegExp[] = [
  /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g,
  /\bhttps?:\/\/[^\s<>()]+/gi,
  /\b[\w@./-]*\/[\w@.-]+\b/g,
  /\b[\w-]+\.[a-z]{1,6}\b/gi,
  /\b[0-9a-f]{7,40}\b/g,
  /\b(?=[a-zA-Z0-9]*(?:_|\.[a-zA-Z0-9_]))[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*\b/g,
  /\b[a-zA-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g,
  /`([^`]+)`/g,
];

/**
 * Every identifier a piece of text names, lower-cased and deduplicated.
 */
export function identifiersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[0]).trim().toLowerCase();
      if (raw.length > 0) out.add(raw);
    }
  }
  return out;
}

/**
 * Does this message name anything the ones before it did not?
 */
export function introducesSomethingNew(text: string, alreadySeen: ReadonlySet<string>): boolean {
  for (const id of identifiersIn(text)) {
    if (!alreadySeen.has(id)) return true;
  }
  return false;
}
