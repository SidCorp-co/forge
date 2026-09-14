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
// cm:why the shapes, in the order tried: an issue key, a URL, a path, a file name, a revision of seven hex digits or more, a snake or dotted identifier, a camelCase one, and anything inside a code span.
// cm:guard ordinary prose deliberately yields NOTHING here — no bare words, no punctuation, no stop-list to maintain. The test the guard applies is "did this message carry information the room did not have", and "thanks, will do" carrying none is the correct answer rather than a gap.
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

// cm:guard every alternative here is DISJOINT from the one beside it — the run before a separator excludes the separator, and the camel run's tail excludes its own start — because these patterns are run over text anybody in a room can type. Overlapping classes give a hostile string exponentially many ways to be split, which CodeQL raised as high on this file's first version. Measured 2026-09-14 it was not yet REACHABLE — a `\b` after a word character never forces the failure that backtracking needs, so the pattern always succeeded in under a tenth of a millisecond — and it is fixed by construction anyway, because the next editor who adds an anchor or a suffix should not have to notice that they made it reachable (ISS-1004).

// cm:guard the second half of that rule, and the half the first attempt at it dropped: the classes are owed the LANGUAGE as well as the disjointness. `_` is a token character and not a separator, which is what names `foo__bar`, `foo._bar` and `foo_bar_`; `.` is the only separator and is never doubled, which is what leaves `wait...maybe` and `foo..bar` as the prose they are. The lookahead is how "this token carries a separator at all" is said without a second alternative to be ambiguous against — the first non-alphanumeric character must be a `_`, or a `.` the body goes on to consume. One shape is deliberately WIDER than the pattern this restores: `end_`, an alphanumeric run with a single trailing underscore, is now named, where `end__` already was — the old rule named the second and not the first only because its `[\w]+` happened to swallow the extra underscore, which is an accident and not a judgement. Read both halves before editing the pattern: narrowing the language is silent, nothing goes red, and its only symptom is the loop breaker firing EARLIER and cutting an exchange that was working (ISS-1004, triage of aa6980c3).

// cm:guard a BARE number is deliberately NOT an identifier, and the temptation to add one is the hole: two agents trading "retry 1", "retry 2", "retry 3" would each be introducing something new and the loop breaker would never fire, which is the cost bound that replaced the mention gate failing open. A number attached to something — `ISS-1004`, `v1.2.3`, `0244_conversation_windows.sql` — is already caught by the pattern that owns that shape (ISS-1004, review F4).

/**
 * Every identifier a piece of text names, lower-cased and deduplicated.
 */
// cm:guard case is folded and the set is unordered on purpose: a room that says `TurnRunner` after saying `turnRunner` has introduced nothing, and treating the two as different identifiers would hand the loop breaker an escape hatch anybody could type into for ever.
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
// cm:guard the comparison is against everything ALREADY SEEN and not against the previous message alone: two agents alternating between the same two file names would each "introduce" what the other just said, which is precisely the bounce this is here to cut.
export function introducesSomethingNew(text: string, alreadySeen: ReadonlySet<string>): boolean {
  for (const id of identifiersIn(text)) {
    if (!alreadySeen.has(id)) return true;
  }
  return false;
}
