// The `/skill-name` token rule for the composer's slash menu (ISS-718), kept
// pure and DOM-free so the boundaries are testable without mounting a textarea.
//
// A token is only a slash-command when it opens the line or follows whitespace —
// otherwise `and/or`, a URL path and `24/7` would all pop the menu open while
// someone is typing prose.

/** An active `/…` token under the caret. `end` is the caret itself. */
export interface SlashToken {
  /** Index of the `/`. */
  start: number;
  /** Index one past the last character of the token (= the caret). */
  end: number;
  /** The text after the `/`, which is what the list filters on (may be ''). */
  query: string;
}

/**
 * The slash token the caret sits in, or null when there is none.
 *
 * Requires: the `/` opens the value or follows whitespace; every character
 * between it and the caret is non-whitespace. A caret before the `/`, or past a
 * space that ended the token, is not inside it.
 */
export function findSlashToken(value: string, caret: number): SlashToken | null {
  const at = Math.max(0, Math.min(caret, value.length));
  let i = at - 1;
  while (i >= 0) {
    const ch = value[i] as string;
    if (ch === '/') break;
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  if (i < 0) return null;
  const before = i > 0 ? (value[i - 1] as string) : '';
  if (before && !/\s/.test(before)) return null;
  return { start: i, end: at, query: value.slice(i + 1, at) };
}

/**
 * Replace `token` with `/name ` and report where the caret belongs afterwards
 * (just past the inserted trailing space, so the user types their message
 * straight on). A space already following the token is not duplicated.
 */
export function replaceSlashToken(
  value: string,
  token: SlashToken,
  name: string,
): { value: string; caret: number } {
  const insert = `/${name}`;
  const followedBySpace = /\s/.test(value[token.end] ?? '');
  const suffix = followedBySpace ? '' : ' ';
  const next = value.slice(0, token.start) + insert + suffix + value.slice(token.end);
  return { value: next, caret: token.start + insert.length + suffix.length };
}

/**
 * Case-insensitive substring match on the skill name, name-order preserved.
 * An empty query lists everything — opening the menu on a bare `/` should show
 * the whole set, not nothing.
 */
export function filterSkillsByQuery<T extends { name: string }>(skills: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((s) => s.name.toLowerCase().includes(q));
}
