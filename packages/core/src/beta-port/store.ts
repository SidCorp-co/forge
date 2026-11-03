// What the beta port reads and writes in this instance's own DB (ISS-923): its pairs, which it owns,
// and the dev side it reads: the twin projects by slug, and the issues a pair or a first line names.
// Nothing beta answers is stored here but the pair's own bookkeeping.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { betaPortPairs, issues, projects } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';

export interface DevTwin {
  id: string;
  slug: string;
  createdBy: string;
  prefix: string | null;
}

export interface DevIssue {
  id: string;
  key: string;
  status: string;
}

export interface Pair {
  betaIssueId: string;
  betaKey: string;
  devIssueId: string;
  lastMirroredStatus: string | null;
}

/** The live dev project carrying each slug exactly: a twin is never guessed. */
export async function devTwinsBySlug(slugs: readonly string[]): Promise<Map<string, DevTwin>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, slug: projects.slug, createdBy: projects.createdBy })
    .from(projects)
    .where(and(inArray(projects.slug, [...slugs]), isNull(projects.archivedAt)));
  const twins = new Map<string, DevTwin>();
  for (const row of rows) {
    twins.set(row.slug, { ...row, prefix: await activeIssuePrefix(row.id) });
  }
  return twins;
}

/** The twin's issues whose first line could name a beta issue: it says forge-beta, or holds a uuid. */
export async function devFirstLines(twin: DevTwin): Promise<(DevIssue & { firstLine: string })[]> {
  const firstLine = sql<string>`split_part(coalesce(${issues.description}, ''), E'\\n', 1)`;
  const rows = await db
    .select({ id: issues.id, issSeq: issues.issSeq, status: issues.status, firstLine })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, twin.id),
        sql`(${firstLine} ILIKE '%forge-beta%' OR ${firstLine} ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    key: formatIssueRef(twin.prefix, r.issSeq),
    status: r.status,
    firstLine: r.firstLine,
  }));
}

/** The dev issues of a twin by id, with their keys. */
export async function devIssuesById(
  twin: DevTwin,
  ids: readonly string[],
): Promise<Map<string, DevIssue>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: issues.id, issSeq: issues.issSeq, status: issues.status })
    .from(issues)
    .where(inArray(issues.id, [...ids]));
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, key: formatIssueRef(twin.prefix, r.issSeq), status: r.status },
    ]),
  );
}

/** The pair of each beta issue that has one. */
export async function pairsOf(betaIssueIds: readonly string[]): Promise<Map<string, Pair>> {
  if (betaIssueIds.length === 0) return new Map();
  const rows = await db
    .select({
      betaIssueId: betaPortPairs.betaIssueId,
      betaKey: betaPortPairs.betaKey,
      devIssueId: betaPortPairs.devIssueId,
      lastMirroredStatus: betaPortPairs.lastMirroredStatus,
    })
    .from(betaPortPairs)
    .where(inArray(betaPortPairs.betaIssueId, [...betaIssueIds]));
  return new Map(rows.map((r) => [r.betaIssueId, r]));
}

/** Record a pair once; a second write for the same beta issue changes nothing. */
export async function recordPair(pair: Pair & { betaProjectSlug: string }): Promise<void> {
  await db
    .insert(betaPortPairs)
    .values(pair)
    .onConflictDoNothing({ target: betaPortPairs.betaIssueId });
}

/** The dev status last mirrored onto a pair's beta issue, tried or refused. */
export async function recordMirrored(betaIssueId: string, status: string): Promise<void> {
  await db
    .update(betaPortPairs)
    .set({ lastMirroredStatus: status, at: new Date() })
    .where(eq(betaPortPairs.betaIssueId, betaIssueId));
}
