import type { WaitingCommit } from '../integrations/github/live-divergence.js';
import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { commitOwners, type OwnerVia, subjectOf } from './commit-owners.js';

interface ReadingBranches {
  /** Null only on a refusal: a project naming no base branch has nothing to compare. */
  baseBranch: string | null;
  liveBranch: string;
}

/** One comparison of a `promote` project's base branch with its live branch, or why none was taken. */
export type LiveReading =
  | (ReadingBranches & {
      kind: 'measured';
      baseBranch: string;
      baseSha: string;
      liveSha: string;
      aheadBy: number;
      commits: WaitingCommit[];
      complete: boolean;
      startedAt: Date;
    })
  | (ReadingBranches & { kind: 'refused'; reason: string; startedAt: Date })
  | (ReadingBranches & { kind: 'pending'; reason: string });

export interface LiveReachEvidence {
  sha: string;
  subject: string;
  /** `merged_commit` — the issue's own observed merge; the others as `commitOwners` counted it. */
  via: 'merged_commit' | OwnerVia;
}

type Measured = ReadingBranches & {
  baseBranch: string;
  measuredAt: string;
  baseSha: string;
  liveSha: string;
};

/** Whether one merged issue's work is on the live branch, as far as one reading can say. */
export type LiveReach =
  | (Measured & { state: 'not_on_live'; evidence: LiveReachEvidence[] })
  | (Measured & { state: 'none_waiting' })
  | (ReadingBranches & { state: 'unmeasured'; measuredAt: string | null; reason: string });

export interface LiveReachIssue {
  issSeq: number;
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The pattern matching a reference under any of `prefixes` or the shared legacy one. */
export function issueRefPattern(prefixes: readonly string[]): RegExp {
  const all = [...new Set([...prefixes, LEGACY_ISSUE_PREFIX].map((p) => p.toUpperCase()))];
  return new RegExp(
    `(?<![A-Za-z0-9])(?:${all.map(escapeRe).join('|')})-(\\d{1,10})(?![A-Za-z0-9])`,
    'gi',
  );
}

/** The waiting commits that are this issue's merge or its work by `commitOwners`, in the reading's order. */
export function evidenceFor(
  issue: LiveReachIssue,
  reading: { commits: readonly WaitingCommit[]; baseBranch: string },
  pattern: RegExp,
): LiveReachEvidence[] {
  const own = (issue.mergedCommitSha ?? '').trim().toLowerCase();
  const owners = commitOwners(reading.commits, pattern, reading.baseBranch);
  const out: LiveReachEvidence[] = [];
  for (const c of reading.commits) {
    const sha = c.sha.toLowerCase();
    const via = own !== '' && sha === own ? 'merged_commit' : owners.get(sha)?.get(issue.issSeq);
    if (via) out.push({ sha: c.sha, subject: subjectOf(c.message), via });
  }
  return out;
}

function mergedAfter(issue: LiveReachIssue, startedAt: Date): boolean {
  if (issue.mergedAt == null) return false;
  const at = new Date(issue.mergedAt).getTime();
  return !Number.isNaN(at) && at > startedAt.getTime();
}

/**
 * One issue's verdict. `null` where there is nothing to place: no reading (the project is not
 * `promote`) or no merged mark. Absence of evidence is never read as "on live" — it is
 * `none_waiting` only from a complete reading taken after the merge, and `unmeasured` otherwise.
 */
export function liveReachOf(
  issue: LiveReachIssue,
  reading: LiveReading | null,
  pattern: RegExp,
): LiveReach | null {
  if (!reading || issue.mergedAt == null) return null;
  const branches = { baseBranch: reading.baseBranch, liveBranch: reading.liveBranch };
  if (reading.kind === 'pending') {
    return { ...branches, state: 'unmeasured', measuredAt: null, reason: reading.reason };
  }
  const measuredAt = reading.startedAt.toISOString();
  if (reading.kind === 'refused') {
    return { ...branches, state: 'unmeasured', measuredAt, reason: reading.reason };
  }
  const measured = {
    baseBranch: reading.baseBranch,
    liveBranch: reading.liveBranch,
    measuredAt,
    baseSha: reading.baseSha,
    liveSha: reading.liveSha,
  };
  const evidence = evidenceFor(issue, reading, pattern);
  if (evidence.length > 0) return { ...measured, state: 'not_on_live', evidence };
  if (!reading.complete) {
    return {
      ...branches,
      state: 'unmeasured',
      measuredAt,
      reason: `${reading.baseBranch} is ${reading.aheadBy} commits ahead of ${reading.liveBranch} and the reading listed only ${reading.commits.length}, so a commit of this issue may be among the ones it did not read`,
    };
  }
  if (mergedAfter(issue, reading.startedAt)) {
    return {
      ...branches,
      state: 'unmeasured',
      measuredAt,
      reason: `this issue merged after the last reading of ${reading.baseBranch} against ${reading.liveBranch}, which the next reading answers`,
    };
  }
  return { ...measured, state: 'none_waiting' };
}
