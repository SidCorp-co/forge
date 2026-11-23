/**
 * What an observed commit a mark named writes over a standing asserted mark (ISS-1445,
 * `merge-record.ts:recordIssueMerge` `amendsAsserted`): which rows stand asserted, the paths a box
 * read that the amend keeps, and the paths it drops as its event tells them.
 */

import type { LandingArtifact, ReadPaths } from '@forge/contracts/landing-artifacts';
import { type SQL, sql } from 'drizzle-orm';
import { issues } from '../db/schema.js';
import { designOnlyStamp, type MergeMarkColumns } from './merge-mark-kind.js';

export function withoutPaths<T extends { mergedPaths: unknown }>(row: T): Omit<T, 'mergedPaths'> {
  const { mergedPaths: _, ...rest } = row;
  return rest;
}

/**
 * The asserted mark a row stands on, where it does (ISS-1445): stamped, no commit observed, and not
 * the stamp a design approval alone wrote, whose code lands at its own time (`designOnlyStamp`).
 * `pathsAt` is the commit a box read its paths at, if it sent any.
 */
export function assertedMarkOf(
  prior: MergeMarkColumns & {
    mergedArtifacts: LandingArtifact[] | null;
    mergedPaths: ReadPaths | null;
  },
): { at: Date; pathsAt: string | null } | null {
  if (prior.mergedAt == null || (prior.mergedCommitSha ?? '').trim() !== '') return null;
  if (designOnlyStamp(prior) !== null) return null;
  return { at: new Date(prior.mergedAt), pathsAt: prior.mergedPaths?.commit ?? null };
}

/** The paths a box read, kept only where they were read at `commit`; any other commit's are dropped. */
export function pathsKeptAt(commit: string): SQL {
  return sql`CASE WHEN starts_with(${commit.toLowerCase()}, lower(${issues.mergedPaths} ->> 'commit'))
    THEN ${issues.mergedPaths} END`;
}

/** The `issue.updated` fields an amend adds where it dropped the paths a box read at another commit. */
export function droppedPathsOf(
  amended: { pathsAt: string | null } | null,
  held: ReadPaths | null,
): { before: Record<string, unknown>; after: Record<string, unknown>; fields: string[] } {
  if (!amended?.pathsAt) return { before: {}, after: {}, fields: [] };
  return { before: { mergedPaths: held }, after: { mergedPaths: null }, fields: ['mergedPaths'] };
}
