// The find door's gaps (ISS-1256): each query that matched nothing in a project over a window, as
// often as it was asked, most asked first. A gap is where a term or a rule is missing; an agent that
// sees one writes it, and the next find of the same words is no gap.

import type { FindGapsView } from '@forge/contracts/find';
import { and, count, desc, eq, gte, max, min, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { findMisses } from '../db/schema.js';

const DAY_MS = 86_400_000;
/** At most this many gaps answer one read. */
export const FIND_GAPS_SHOWN = 100;

export async function readFindGaps(
  projectId: string,
  days: number,
  now: Date = new Date(),
): Promise<FindGapsView> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const asked = sql<string>`lower(${findMisses.query})`;
  const rows = await db
    .select({
      query: asked,
      searches: count(),
      firstAt: min(findMisses.createdAt),
      lastAt: max(findMisses.createdAt),
      lastBy: sql<string>`(array_agg(${findMisses.askedBy} ORDER BY ${findMisses.createdAt} DESC))[1]`,
    })
    .from(findMisses)
    .where(and(eq(findMisses.projectId, projectId), gte(findMisses.createdAt, since)))
    .groupBy(asked)
    .orderBy(desc(count()), desc(max(findMisses.createdAt)))
    .limit(FIND_GAPS_SHOWN);
  const iso = (at: Date | string | null) => (at ? new Date(at).toISOString() : since.toISOString());
  return {
    projectId,
    window: { days, since: since.toISOString() },
    gaps: rows.map((r) => ({
      query: r.query,
      searches: Number(r.searches),
      firstAt: iso(r.firstAt),
      lastAt: iso(r.lastAt),
      lastBy: r.lastBy,
    })),
  };
}
