// `@username` where username = email-local-part. Allow letters, digits,
// dot, underscore, plus, hyphen — covers the realistic surface of email
// local parts without dragging in the full RFC 5322 grammar.
const MENTION_RE = /(?:^|[^a-zA-Z0-9_.+-])@([a-zA-Z0-9_.+-]+)/g;

/**
 * Extract `@username` handles from a comment body.
 *
 * - Returns lowercased, deduplicated usernames in the order they first appear.
 * - A handle preceded by another word-character (e.g. `email@host`) is skipped
 *   so addresses inside the body don't trigger spurious mentions.
 * - Trailing `.` / `-` is stripped so `@bob.` resolves to `bob`, while
 *   interior dots (`@alice.smith`) stay intact.
 *
 * Pure — no DB access, safe to call from unit tests.
 */
export function parseMentions(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const handle = match[1]?.toLowerCase().replace(/[.-]+$/, '');
    if (!handle) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}
