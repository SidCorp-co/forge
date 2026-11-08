import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { memoizedPerId } from '../db/read-memo.js';
import { issues, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

/**
 * What a read asks of an issue by its id alone, whichever reader asks: its project, its key and
 * where its merge stands. One read answers every reader of a request (`issueDisplayIds`, a
 * requirement's issue projects, an issue's landed build): a person's attention read the 3,520
 * issues their requirements link three times over, once for each (ISS-1070 r11).
 */
export interface IssueCore {
  id: string;
  projectId: string;
  /** `ISS-nn`, by the project's prefix. */
  key: string;
  status: string;
  mergedAt: Date | null;
  mergedCommitSha: string | null;
  mergedHead: MergedHead | null;
  /** Its merge names a landing outside git: artifacts and no paths read from a tree. */
  landedOutsideGit: boolean;
}

/** Each named issue's {@link IssueCore}, every ask of a request read once; none for an issue not held. */
export function issueCoresOf(issueIds: readonly string[]): Promise<Map<string, IssueCore>> {
  // an issue's row is its own: every project's asks are one read (ISS-1070 r6)
  return memoizedPerId('issueCore', issueIds, issueCoresRead);
}

async function issueCoresRead(issueIds: readonly string[]): Promise<Map<string, IssueCore>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      status: issues.status,
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedHead: issues.mergedHead,
      landedOutsideGit: sql<boolean>`(${issues.mergedArtifacts} IS NOT NULL AND ${issues.mergedPaths} IS NULL)`,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(sql`${issues.id} = ANY(${uuidArray(issueIds)})`);
  return new Map(
    rows.map(({ issSeq, issuePrefix, ...r }) => [
      r.id,
      { ...r, key: formatIssueRef(issuePrefix, issSeq) },
    ]),
  );
}

/** `ISS-nn` for each of these in one read, on the caller's transaction where it has one; the uuid
 *  keying them is on no screen. */
export async function issueDisplayIds(
  issueIds: string[],
  executor: Tx = db,
): Promise<Map<string, string>> {
  if (executor !== db) return displayIdsRead(issueIds, executor);
  const cores = await issueCoresOf(issueIds);
  return new Map([...cores].map(([id, c]) => [id, c.key]));
}

async function displayIdsRead(
  issueIds: readonly string[],
  executor: Tx,
): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const rows = await executor
    .select({ id: issues.id, issSeq: issues.issSeq, issuePrefix: projects.issuePrefix })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(sql`${issues.id} = ANY(${uuidArray(issueIds)})`);
  return new Map(rows.map((r) => [r.id, formatIssueRef(r.issuePrefix, r.issSeq)]));
}

/** `ISS-nn` and the title of each of these in the project, in one read: how a person is shown an issue a uuid names. */
export async function issueKeysAndTitles(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, { key: string; title: string }>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      title: issues.title,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...issueIds])));
  return new Map(
    rows.map((r) => [r.id, { key: formatIssueRef(r.issuePrefix, r.issSeq), title: r.title }]),
  );
}
