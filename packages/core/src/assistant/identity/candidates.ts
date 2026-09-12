/**
 * ISS-977 — which Forge users a chat speaker's own address could be, and which
 * of them may confirm.
 *
 * Two tiers, and they are not equal. The whole normalized address is the only
 * one a confirmation is accepted on. A local-part match against a different
 * domain is offered so a person can SEE the near-miss and learn which address
 * to fix; accepting it would let anyone bind a chat account whose local part
 * happens to equal their own on some other domain.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';

export type CandidateTier = 'address' | 'local-part';

export interface SpeakerCandidate {
  userId: string;
  email: string;
  matchedOn: CandidateTier;
  /** Whether a confirmation by this user would be accepted. */
  confirmable: boolean;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase();
  if (!email) return null;
  const at = email.indexOf('@');
  return at > 0 && at < email.length - 1 ? email : null;
}

function localPart(email: string): string {
  return email.slice(0, email.indexOf('@'));
}

/**
 * The local-part tier's SQL pattern, exported so the escaping is testable
 * without reading a query apart.
 */
// cm:guard escape the LIKE metacharacters before the local part reaches the pattern — an address whose local part contains `%` would otherwise match every local part and every domain, i.e. propose the whole user table as candidates for one speaker
export function likePattern(normalizedEmail: string): string {
  return `${localPart(normalizedEmail).replace(/([%_\\])/g, '\\$1')}@%`;
}

/**
 * Every Forge user the channel's address could name, tagged with the tier it
 * matched on. Writes nothing and selects nothing.
 */
// cm:guard email ONLY — never the chat display name, on either tier. A username is re-assignable on most chat servers, so a candidate derived from one hands the next holder of that name a confirmation prompt for the previous holder's Forge account.
// cm:guard a lone candidate is a proposal like any other and is never returned as a selection. Selecting it because it is alone is guessing the intent behind input that named no user, and the guess would be an identity.
export async function proposeCandidates(channelEmail: string): Promise<SpeakerCandidate[]> {
  const email = normalizeEmail(channelEmail);
  if (!email) return [];
  const pattern = likePattern(email);
  // cm:guard keep the OR parenthesized — AND binds tighter than OR in SQL, so an unwrapped fragment reads as (kind='human' AND LIKE …) OR (email = …) and the exact-address branch escapes the human filter entirely
  // cm:guard `human` only — an agent row carries a synthesized address it cannot receive mail at (`db/schema.ts:users.kind`), so an agent whose synthesized local part collides with a real person's would be offered as a candidate for them.
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.kind, 'human'),
        sql`(lower(${users.email}) LIKE ${pattern} ESCAPE '\\' OR lower(${users.email}) = ${email})`,
      ),
    );
  const candidates: SpeakerCandidate[] = [];
  for (const row of rows) {
    const own = normalizeEmail(row.email);
    if (!own) continue;
    if (own === email) {
      candidates.push({ userId: row.id, email: own, matchedOn: 'address', confirmable: true });
    } else if (localPart(own) === localPart(email)) {
      candidates.push({ userId: row.id, email: own, matchedOn: 'local-part', confirmable: false });
    }
  }
  return candidates.sort(
    (a, b) => a.matchedOn.localeCompare(b.matchedOn) || a.email.localeCompare(b.email),
  );
}
