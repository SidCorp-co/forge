// What the beta port reads and writes in this instance's own DB (ISS-923): its pairs, which it owns,
// and the dev side it reads: the twin projects by slug, and the issues a pair or a first line names.
// Nothing beta answers is stored here but the pair's own bookkeeping.

import { and, asc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { betaPortPairs, issues, projects } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import { orgKnowledgeCreatedAt } from '../knowledge/index.js';
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

/** A dev issue as a mirror reads it: where its work landed, when it did. */
export interface MirroredDevIssue extends DevIssue {
  mergedLanding: string | null;
  mergedCommitSha: string | null;
  mergedAt: Date | null;
}

export interface Pair {
  betaIssueId: string;
  betaKey: string;
  devIssueId: string;
  /** The dev status whose move beta took; never one it refused. */
  lastMirroredStatus: string | null;
  /** The dev status last tried, taken or not; null on a pair tried under the old rule. */
  lastTriedStatus: string | null;
  /** The beta status beta stood at after that try. */
  betaReached: string | null;
  /** When a close was last tried with beta's mark in its project's landing shape; null before. */
  closeShapeTriedAt: Date | null;
}

/** The slug of the org knowledge entry holding the owner's ruling: its creation is the cutoff. */
export const RULING_SLUG = 'beta-issues-are-worked-on-dev';

/**
 * When the owner ruled that beta issues are worked on dev: the creation of the ruling's entry in
 * the knowledge of the org `projectId` belongs to, read at every fire; null where it holds none.
 */
export function rulingCutoff(projectId: string): Promise<Date | null> {
  return orgKnowledgeCreatedAt(projectId, RULING_SLUG);
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

/** The dev issues of a twin by id, with their keys and where their work landed. */
export async function devIssuesById(
  twin: DevTwin,
  ids: readonly string[],
): Promise<Map<string, MirroredDevIssue>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      status: issues.status,
      mergedLanding: issues.mergedLanding,
      mergedCommitSha: issues.mergedCommitSha,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(inArray(issues.id, [...ids]));
  return new Map(
    rows.map(({ issSeq, ...r }) => [r.id, { ...r, key: formatIssueRef(twin.prefix, issSeq) }]),
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
      lastTriedStatus: betaPortPairs.lastTriedStatus,
      betaReached: betaPortPairs.betaReached,
      closeShapeTriedAt: betaPortPairs.closeShapeTriedAt,
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

/**
 * One try of a dev status onto a pair's beta issue: the status tried, the beta status beta stood at
 * after it, and, where beta took the move, that status as mirrored. A try beta did not take leaves
 * the mirrored status as it was, unless it named this same dev status, which beta never took. A
 * close whose mark question was settled in the beta project's landing shape says so (`shapeSettled`),
 * so it is not tried again for it.
 */
export async function recordTry(args: {
  betaIssueId: string;
  tried: string;
  reached: string;
  taken: boolean;
  shapeSettled?: boolean;
}): Promise<void> {
  await db
    .update(betaPortPairs)
    .set({
      ...(args.shapeSettled ? { closeShapeTriedAt: new Date() } : {}),
      lastTriedStatus: args.tried,
      betaReached: args.reached,
      lastMirroredStatus: args.taken
        ? args.tried
        : sql`nullif(${betaPortPairs.lastMirroredStatus}, ${args.tried})`,
      at: new Date(),
    })
    .where(eq(betaPortPairs.betaIssueId, args.betaIssueId));
}

/** A pair whose dev issue may hold only its provenance line, with what its backfill writes as. */
export interface StubPair {
  betaIssueId: string;
  betaKey: string;
  betaProjectSlug: string;
  devIssueId: string;
  devKey: string;
  devProjectId: string;
  /** Whose project the dev issue is in: the port's actor on create, and the backfill's. */
  devProjectOwner: string;
  title: string;
  description: string | null;
}

/**
 * Every pair owing no recorded backfill whose dev description is one line opening with the
 * provenance prefix, oldest pair first: the candidates `isPortStub` then decides on exactly. A
 * description of more than one line was written with a body or edited, and is never read here.
 */
export async function stubPairCandidates(): Promise<StubPair[]> {
  const trimmed = sql`rtrim(coalesce(${issues.description}, ''), E' \t\r\n')`;
  const rows = await db
    .select({
      betaIssueId: betaPortPairs.betaIssueId,
      betaKey: betaPortPairs.betaKey,
      betaProjectSlug: betaPortPairs.betaProjectSlug,
      devIssueId: betaPortPairs.devIssueId,
      issSeq: issues.issSeq,
      devProjectId: issues.projectId,
      devProjectOwner: projects.createdBy,
      title: issues.title,
      description: issues.description,
    })
    .from(betaPortPairs)
    .innerJoin(issues, eq(issues.id, betaPortPairs.devIssueId))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(
        isNull(betaPortPairs.bodyBackfilledAt),
        like(issues.description, 'Ported from forge-beta %'),
        sql`strpos(${trimmed}, E'\n') = 0`,
      ),
    )
    .orderBy(asc(betaPortPairs.createdAt), asc(betaPortPairs.betaIssueId));
  const prefixes = new Map<string, string | null>();
  const out: StubPair[] = [];
  for (const { issSeq, ...row } of rows) {
    if (!prefixes.has(row.devProjectId)) {
      prefixes.set(row.devProjectId, await activeIssuePrefix(row.devProjectId));
    }
    out.push({ ...row, devKey: formatIssueRef(prefixes.get(row.devProjectId) ?? null, issSeq) });
  }
  return out;
}

/** A dev issue's description as it stands now: read again right before a backfill writes over it. */
export async function devDescriptionOf(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.description ?? null;
}

/** Record a pair's body backfill as made by `fireId`, so it is never made again. */
export async function recordBackfill(betaIssueId: string, fireId: string): Promise<void> {
  await db
    .update(betaPortPairs)
    .set({ bodyBackfilledAt: new Date(), bodyBackfillFireId: fireId, at: new Date() })
    .where(eq(betaPortPairs.betaIssueId, betaIssueId));
}
