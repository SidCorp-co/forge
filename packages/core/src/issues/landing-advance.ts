/**
 * A later landing of the same issue moves its mark forward (ISS-1421 round 7): a commit that carries
 * the one the mark holds replaces it, one the held commit carries changes nothing, and one on another
 * line is a different landing. The write names the commit it moves from and lands only while the row
 * still holds it, so two landings racing from one mark cannot step back.
 */

import { and, eq, sql } from 'drizzle-orm';
import { forgeAuthorId } from '../comments/forge-author.js';
import { postSystemComment } from '../comments/system-write.js';
import { db, type Tx } from '../db/client.js';
import { comments } from '../db/schema.js';
import { logger } from '../logger.js';
import { type RepositoryAccessDeps, withRepository } from '../projects/repository-access.js';
import { saying } from '../projects/repository-reader.js';
import {
  type CommitLanding,
  type CommitLandingRefusalCode,
  readCommitLanding,
} from './commit-landing.js';
import type { LandingShape } from './landing-evidence.js';
import {
  type MergeMarkKind,
  readMergeColumns,
  recordIssueMerge,
  shortCommit as s,
  withReason,
} from './merge-record.js';

/** How a candidate commit stands against the commit a mark holds. */
export type LandingStanding =
  | { kind: 'same' }
  | { kind: 'forward' }
  | { kind: 'contained' }
  | { kind: 'other' }
  | { kind: 'unread'; why: string };

/** A commit a later landing names: its sha, when it landed, and where Forge read it. */
export interface LandingCandidate {
  sha: string;
  at: Date;
  via: 'kernel' | 'event' | 'repository';
}

export type LandingAdvance =
  /** The row holds no observed commit, so there is nothing to move from. */
  | { kind: 'empty' }
  | { kind: 'moved'; from: string; to: string }
  | { kind: 'same'; held: string }
  | { kind: 'contained'; held: string }
  | { kind: 'other'; held: string }
  | { kind: 'unread'; held: string; why: string };

/** A lost compare-and-swap is read again this many times before the race is reported. */
const ATTEMPTS = 3;

/** The same commit, an abbreviation of it included. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x !== '' && y !== '' && (x.startsWith(y) || y.startsWith(x));
}

/** Read through the project's repository: `descends` both ways. */
export async function standingAgainst(
  projectId: string,
  held: string,
  candidate: string,
  deps: Partial<RepositoryAccessDeps> = {},
): Promise<LandingStanding> {
  if (sameCommit(held, candidate)) return { kind: 'same' };
  return withRepository(
    projectId,
    async (access): Promise<LandingStanding> => {
      if (access.kind === 'refused') return { kind: 'unread', why: saying(access) };
      const forward = await access.reader.descends(held, candidate);
      if ('why' in forward) return { kind: 'unread', why: forward.why };
      if (forward.contains) return { kind: 'forward' };
      const back = await access.reader.descends(candidate, held);
      if ('why' in back) return { kind: 'unread', why: back.why };
      return { kind: back.contains ? 'contained' : 'other' };
    },
    deps,
  );
}

/**
 * Move the row's observed commit to `candidate` where it carries the one held. A write that loses
 * its compare-and-swap reads the row again and compares again; only a write that took is a move.
 */
export async function moveLandingForward(
  args: {
    issueId: string;
    projectId: string;
    candidate: LandingCandidate;
    /** The issue's declared lane the caller judged on, held as the mark writer holds it. */
    declared?: string | null;
  },
  deps: Partial<RepositoryAccessDeps> = {},
): Promise<LandingAdvance> {
  const { issueId, projectId, candidate } = args;
  let held: string | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    held = (await readMergeColumns(db, issueId)).commitSha?.trim() || null;
    if (!held) return { kind: 'empty' };
    const standing = await standingAgainst(projectId, held, candidate.sha, deps);
    if (standing.kind === 'same') return { kind: 'same', held };
    if (standing.kind === 'contained') return { kind: 'contained', held };
    if (standing.kind === 'other') return { kind: 'other', held };
    if (standing.kind === 'unread') return { kind: 'unread', held, why: standing.why };
    const wrote = await recordIssueMerge(db, {
      issueId,
      ...(args.declared === undefined ? {} : { declared: args.declared }),
      evidence: {
        kind: 'observed',
        commitSha: candidate.sha,
        mergedAt: candidate.at,
        via: candidate.via,
        supersedes: held,
      },
    });
    if (wrote.wrote) return { kind: 'moved', from: held, to: candidate.sha };
  }
  return {
    kind: 'unread',
    held: held ?? '',
    why: `the mark moved ${ATTEMPTS} times while commit ${candidate.sha} was being compared with it`,
  };
}

// Each answer below is at most three short sentences: what happened, why, what to do.
export function movedSentence(from: string, to: string): string {
  return `The landing moved from commit ${s(from)} to commit ${s(to)}, which carries it.`;
}

/** A named commit Forge could not check, on an issue already marked: where the mark stays, what
 *  was not checked, and the step, with the host's reason quoted beneath. `stays` is `markStays`. */
export function unreadAnswer(stays: string, candidate: string, why: string): string {
  return withReason(
    `${stays} Forge could not check commit ${s(candidate)} against the repository. Mark it again once it can.`,
    why,
  );
}

export function notDescendantDetail(held: string, candidate: string): string {
  return (
    `Commit ${s(candidate)} does not descend from commit ${s(held)}, where the mark stays. ` +
    'It is a different landing, so nothing changed. ' +
    'To mark it there, use Unmark, then Mark merged again.'
  );
}

/** What the observed path says on the issue where a merge it saw did not move the mark. */
function stayedComment(outcome: LandingAdvance, candidate: string): string | null {
  const seen = `A pull request of this issue merged at commit ${s(candidate)}`;
  if (outcome.kind === 'other') {
    return `${seen}, which does not descend from commit ${s(outcome.held)}. The mark stays at ${s(outcome.held)}.`;
  }
  if (outcome.kind !== 'unread') return null;
  return withReason(
    `${seen}. Forge could not check it against commit ${s(outcome.held)} in the repository. The mark stays at ${s(outcome.held)}.`,
    outcome.why,
  );
}

async function alreadySaid(tx: Tx, issueId: string, body: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.body, body)))
    .limit(1);
  return Boolean(row);
}

/**
 * A merge Forge observed — GitHub's `pull_request` event or its own merge — on an issue whose mark
 * already holds a commit. A move or a merge that stayed is said on the issue; a redelivery of the
 * same merge reads `same` and says nothing.
 */
export async function advanceObservedLanding(
  args: { issueId: string; projectId: string; candidate: LandingCandidate },
  deps: Partial<RepositoryAccessDeps> = {},
): Promise<LandingAdvance> {
  const outcome = await moveLandingForward(args, deps);
  const body =
    outcome.kind === 'moved'
      ? movedSentence(outcome.from, outcome.to)
      : stayedComment(outcome, args.candidate.sha);
  if (!body) return outcome;
  try {
    // One lock per issue: GitHub's event and Forge's own merge, reporting one merge, say it once.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`landing:${args.issueId}`}))`);
      if (outcome.kind !== 'moved' && (await alreadySaid(tx, args.issueId, body))) return;
      await postSystemComment(
        { issueId: args.issueId, authorId: await forgeAuthorId(tx), body },
        tx,
      );
    });
  } catch (err) {
    logger.warn({ err, issueId: args.issueId }, 'landing advance: the comment was not written');
  }
  return outcome;
}

/**
 * The stamp a merge Forge observed writes: the first one onto an empty mark, and any later one
 * moved forward from the commit the mark holds.
 */
export async function stampObservedMerge(
  args: { issueId: string; projectId: string; candidate: LandingCandidate },
  deps: Partial<RepositoryAccessDeps> = {},
): Promise<{ wrote: boolean; advance: LandingAdvance | null }> {
  const { issueId, candidate } = args;
  const first = await recordIssueMerge(db, {
    issueId,
    evidence: {
      kind: 'observed',
      commitSha: candidate.sha,
      mergedAt: candidate.at,
      via: candidate.via,
    },
  });
  if (first.wrote) return { wrote: true, advance: null };
  const advance = await advanceObservedLanding(args, deps);
  return { wrote: advance.kind === 'moved', advance };
}

export type LaterLanding =
  | (Exclude<LandingAdvance, { kind: 'empty' }> & { candidate: string })
  | {
      kind: 'refused';
      code: CommitLandingRefusalCode;
      detail: string;
      details: Record<string, unknown>;
    };

/** `readCommitLanding`'s answer, where the commit is not one this call already holds. */
async function namedCandidate(
  issueId: string,
  commit: string,
  known: LandingCandidate[],
): Promise<LandingCandidate | Extract<LaterLanding, { kind: 'refused' }> | { why: string }> {
  const hit = known.find((k) => sameCommit(k.sha, commit));
  if (hit) return hit;
  const read = await readCommitLanding({ issueId, commit });
  if (read.ok) return { sha: read.sha, at: read.committedAt, via: 'repository' };
  if (read.unreadable) return { why: read.unreadable.why };
  return { kind: 'refused', code: read.code, detail: read.detail, details: read.details };
}

/**
 * A mark on a row that already holds an observed commit, against a later one: the commit the call
 * names, read as this issue's landing, or else the issue's most recently merged pull request. Null
 * where there is nothing to compare: no commit held, or none named or merged that differs from it.
 */
export async function laterLanding(
  issue: { id: string; projectId: string; declaredLandingShape: LandingShape | null },
  commit: string | undefined,
  observed: { commitSha: string; mergedAt: Date } | null,
  fromRepository: Extract<CommitLanding, { ok: true }> | null,
): Promise<LaterLanding | null> {
  const held = (await readMergeColumns(db, issue.id)).commitSha?.trim();
  if (!held) return null;
  const known: LandingCandidate[] = [
    ...(fromRepository
      ? [{ sha: fromRepository.sha, at: fromRepository.committedAt, via: 'repository' as const }]
      : []),
    ...(observed
      ? [{ sha: observed.commitSha, at: observed.mergedAt, via: 'event' as const }]
      : []),
  ];
  let candidate: LandingCandidate | null = null;
  if (commit) {
    if (sameCommit(held, commit)) return null;
    const named = await namedCandidate(issue.id, commit, known);
    if ('why' in named) return { kind: 'unread', held, why: named.why, candidate: commit };
    if ('kind' in named) return named;
    candidate = named;
  } else if (observed && !sameCommit(held, observed.commitSha)) {
    candidate = { sha: observed.commitSha, at: observed.mergedAt, via: 'event' };
  }
  if (!candidate) return null;
  const outcome = await moveLandingForward({
    issueId: issue.id,
    projectId: issue.projectId,
    candidate,
    declared: issue.declaredLandingShape ?? null,
  });
  return outcome.kind === 'empty' ? null : { ...outcome, candidate: candidate.sha };
}

/** Where a mark that moved nothing stays, in the sentence a repeat says it with. */
export function markStays(
  later: LaterLanding | null,
  kind: MergeMarkKind,
  row: { commitSha: string | null; landing: string | null; claimedCommit: string | null },
): string {
  if (later?.kind === 'contained') {
    return `Commit ${s(later.candidate)} is already in commit ${s(later.held)}, where the mark stays.`;
  }
  if (kind === 'observed' && row.commitSha) return `The mark stays at commit ${s(row.commitSha)}.`;
  if (kind === 'landed' && row.landing) return `The mark stays at ${row.landing}.`;
  return row.claimedCommit
    ? `The mark stays a claim naming commit ${s(row.claimedCommit)}.`
    : 'The mark stays a claim that names no commit.';
}
