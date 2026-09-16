/**
 * What a message introduces that the conversation did not already carry.
 *
 * The loop breaker is built on this rather than on a message count, and the
 * difference is the whole point: two agents settling a cross-repo change trade
 * many messages, and a counter cuts them off in the middle of doing the work
 * this feature exists to let them do. A message that names a new issue, file,
 * revision, address or number is carrying something; one that names nothing the
 * room has not seen is an echo.
 */

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
