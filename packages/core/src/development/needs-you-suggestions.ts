import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';

/** The proposed breakdown or revision suggestion each requirement waits on a signer for, oldest first. */
export async function proposedSuggestionsOf(
  requirementIds: readonly string[],
): Promise<Map<string, { id: string; kind: string }>> {
  if (requirementIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: suggestions.id,
      kind: suggestions.kind,
      requirementId: suggestions.requirementId,
    })
    .from(suggestions)
    .where(
      and(
        inArray(suggestions.requirementId, [...requirementIds]),
        eq(suggestions.status, 'proposed'),
        inArray(suggestions.kind, ['breakdown', 'revision_diff']),
      ),
    )
    .orderBy(asc(suggestions.createdAt));
  const out = new Map<string, { id: string; kind: string }>();
  for (const r of rows) {
    if (r.requirementId && !out.has(r.requirementId))
      out.set(r.requirementId, { id: r.id, kind: r.kind });
  }
  return out;
}
