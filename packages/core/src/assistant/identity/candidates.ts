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
export function likePattern(normalizedEmail: string): string {
  return `${localPart(normalizedEmail).replace(/([%_\\])/g, '\\$1')}@%`;
}

/**
 * Every Forge user the channel's address could name, tagged with the tier it
 * matched on. Writes nothing and selects nothing.
 */
export async function proposeCandidates(channelEmail: string): Promise<SpeakerCandidate[]> {
  const email = normalizeEmail(channelEmail);
  if (!email) return [];
  const pattern = likePattern(email);
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
