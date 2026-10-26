// ISS-1300 r3 — a person's mark carries the commit that landed: docs/modules/issues/merge-mark.md.

import { db } from '../db/client.js';
import type { ActorAgency } from './actor-agency.js';
import { resolveMarkCommit } from './commit-landing.js';
import type { LandingShape } from './landing-evidence.js';
import {
  type AbsentRecord,
  type MergeRecord,
  readMergeColumns,
  recordIssueMerge,
} from './merge-record.js';
import { findIssueById } from './read-service.js';
import { issueIdentities, type LandingRecord } from './verdict-standing.js';

/** A person's commit the repository holds, and the held commit it replaces, if any. */
export interface Stated {
  commit: string;
  repository: string;
  supersedes: string | null;
}

/** Whether the repository was read and holds no commit `commit` names: an unreadable one is not. */
async function absentFrom(projectId: string, commit: string): Promise<boolean> {
  const read = await resolveMarkCommit({ projectId, commit });
  return !read.ok && read.code === 'COMMIT_NOT_IN_REPOSITORY';
}

/**
 * The commit a person named, which the repository holds (`recorded`), is the landing wherever Forge
 * holds none that resolves: no commit on the row and no merged pull request, or one the repository
 * was read and lacks, an abbreviation it cannot resolve included. A landing Forge holds that does
 * resolve, or could not be read for, keeps its own rules, and an agent's commit is never stated.
 */
export async function statedLanding(args: {
  issueId: string;
  projectId: string;
  agency: ActorAgency;
  recorded: { claim: string | null; repository: string | null } | null;
  observed: { commitSha: string } | null;
}): Promise<Stated | null> {
  const { recorded } = args;
  if (args.agency !== 'human' || !recorded?.claim || !recorded.repository) return null;
  const said = { commit: recorded.claim, repository: recorded.repository };
  const held = (await readMergeColumns(db, args.issueId)).commitSha?.trim() || null;
  const forge = held ?? args.observed?.commitSha ?? null;
  if (!forge) return { ...said, supersedes: null };
  if (forge.toLowerCase() === said.commit.toLowerCase()) return null;
  if (!(await absentFrom(args.projectId, forge))) return null;
  return { ...said, supersedes: held };
}

export interface AbsentLanding extends AbsentRecord {
  readonly from: LandingRecord;
}

/**
 * The commit the weighing reads as this issue's landing (`issueIdentities`: the merge mark, else
 * the landing record), where the repository was read and lacks it. The mark's answers read it here,
 * so they and the hold always name one commit and one act (ISS-1300 r5).
 */
export async function recordedAbsent(issue: {
  id: string;
  projectId: string;
}): Promise<AbsentLanding | null> {
  const row = await findIssueById(issue.id);
  const { source, from } = row ? issueIdentities(row) : { source: null, from: undefined };
  if (!source || !from) return null;
  const read = await resolveMarkCommit({ projectId: issue.projectId, commit: source });
  if (read.ok || read.code !== 'COMMIT_NOT_IN_REPOSITORY') return null;
  const repository = typeof read.details.repository === 'string' ? read.details.repository : null;
  return { commit: source, from, repository };
}

/** The landing a person's Commit would replace on a blank repeat: one the repository lacks. */
export async function commitWouldStand(
  issue: { id: string; projectId: string },
  agency: ActorAgency,
): Promise<AbsentLanding | null> {
  return agency === 'human' ? recordedAbsent(issue) : null;
}

/** True where `commit` is the stated commit this row already keeps. */
export async function statedAt(issueId: string, commit: string): Promise<boolean> {
  const held = await readMergeColumns(db, issueId);
  return held.stated && held.commitSha?.toLowerCase() === commit.toLowerCase();
}

/** The stated commit stamped, where there is one. */
export async function stampStated(
  issue: { id: string; projectId: string; declaredLandingShape: LandingShape | null },
  args: { actor: { agency: ActorAgency }; mergedAt?: Date | null },
  recorded: { claim: string | null; repository: string | null } | null,
  observed: { commitSha: string } | null,
): Promise<{ stated: Stated; stamp: MergeRecord } | null> {
  const stated = await statedLanding({
    issueId: issue.id,
    projectId: issue.projectId,
    agency: args.actor.agency,
    recorded,
    observed,
  });
  if (!stated) return null;
  const stamp = await recordIssueMerge(db, {
    issueId: issue.id,
    declared: issue.declaredLandingShape ?? null,
    evidence: {
      kind: 'stated',
      commitSha: stated.commit,
      at: args.mergedAt ?? null,
      supersedes: stated.supersedes,
    },
  });
  return { stated, stamp };
}

/** What the mark's sentence is told of a stated commit, where this call wrote it. */
export function statedWords(
  stated: Stated | null,
  stamp: MergeRecord,
): { repository: string; replaced: string | null } | null {
  return stated && stamp.wrote
    ? { repository: stated.repository, replaced: stated.supersedes }
    : null;
}
