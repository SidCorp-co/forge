// Why each issue a release was asked to claim could not be claimed, and what frees it. The one
// sentence `CLAIM_CONFLICT` answers from every door — the batch, the record, the race at the claim.

import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { TERMINAL_PIPELINE_RUN_STATUSES } from '../pipeline/status-sets.js';
import { ClaimConflictError } from './errors.js';

/** One refused issue. `key` is its `ISS-nn`, or the id as sent where no issue on the project has it. */
export type ClaimConflict =
  | { id: string; key: string; standing: 'claimed'; runId: string; runEnded: boolean }
  | { id: string; key: string; standing: 'status'; status: IssueStatus }
  | { id: string; key: string; standing: 'absent' };

/**
 * The standing of each of `issueIds` that a release on `projectId` cannot claim. A claim is read
 * before the status: it is the lock, and only releasing it frees the issue whatever status it holds.
 */
export async function readClaimConflicts(
  projectId: string,
  gateStatus: IssueStatus,
  issueIds: string[],
  executor: Tx = db,
): Promise<ClaimConflict[]> {
  if (issueIds.length === 0) return [];
  const rows = await executor
    .select({
      id: issues.id,
      status: issues.status,
      claimed: issues.releaseBatchRunId,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      runStatus: pipelineRuns.status,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds)));
  const found = new Map(rows.map((r) => [r.id, r]));
  const ended = new Set<string>(TERMINAL_PIPELINE_RUN_STATUSES);
  const out: ClaimConflict[] = [];
  for (const id of new Set(issueIds)) {
    const row = found.get(id);
    if (!row) {
      out.push({ id, key: id, standing: 'absent' });
      continue;
    }
    const key = formatIssueRef(row.issuePrefix, row.issSeq);
    if (row.claimed !== null) {
      const runEnded = row.runStatus === null || ended.has(row.runStatus);
      out.push({ id, key, standing: 'claimed', runId: row.claimed, runEnded });
    } else if (row.status !== gateStatus) {
      out.push({ id, key, standing: 'status', status: row.status });
    }
  }
  return out;
}

function keys(list: ClaimConflict[]): string {
  return list.map((c) => c.key).join(', ');
}

function isAre(list: unknown[]): string {
  return list.length === 1 ? 'is' : 'are';
}

function groupBy<T>(list: T[], by: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of list) out.set(by(item), [...(out.get(by(item)) ?? []), item]);
  return out;
}

type Standing<S extends ClaimConflict['standing']> = Extract<ClaimConflict, { standing: S }>;

function ofStanding<S extends ClaimConflict['standing']>(
  conflicts: ClaimConflict[],
  standing: S,
): Standing<S>[] {
  return conflicts.filter((c): c is Standing<S> => c.standing === standing);
}

function claimedSentence(projectId: string, runId: string, list: Standing<'claimed'>[]): string {
  const batch = `/api/projects/${projectId}/release-batches/${runId}`;
  if (!list.some((c) => c.runEnded)) {
    return `${keys(list)} ${isAre(list)} claimed by release batch ${runId}, which is still running: read it with GET ${batch}/state, and its claims are released when it ends.`;
  }
  const them = list.length === 1 ? 'it' : 'them';
  return `${keys(list)} ${isAre(list)} still claimed by release batch ${runId}, which has ended: abort it with POST ${batch}/abort and a body of {"promotedRoster":"return-to-gate"}, which releases the claim and puts an issue still at \`releasing\` back at the release gate, then send ${them} again.`;
}

/** The refusal, one sentence per reason, each naming its issues by key. */
export function claimConflictSentence(
  projectId: string,
  gateStatus: string,
  conflicts: ClaimConflict[],
): string {
  const n = conflicts.length;
  const parts = [`${n} issue${n === 1 ? '' : 's'} named here cannot be claimed for a release.`];
  for (const [runId, list] of groupBy(ofStanding(conflicts, 'claimed'), (c) => c.runId)) {
    parts.push(claimedSentence(projectId, runId, list));
  }
  for (const [status, list] of groupBy(ofStanding(conflicts, 'status'), (c) => c.status)) {
    parts.push(
      `${keys(list)} ${isAre(list)} at \`${status}\`, not \`${gateStatus}\`: a release carries an issue only once it reaches the release gate.`,
    );
  }
  const absent = ofStanding(conflicts, 'absent');
  if (absent.length > 0) {
    parts.push(
      `${keys(absent)} ${absent.length === 1 ? 'is no issue' : 'are no issues'} on this project.`,
    );
  }
  return parts.join(' ');
}

/**
 * The error a claim that lost a race throws: the ids it did not take, and each one's standing read
 * after the loss, so the refusal names what took it. An id the read finds free again keeps its place
 * in `issueIds`, and a list the read found nothing for keeps the generic sentence.
 */
export async function claimConflictAt(
  projectId: string,
  gateStatus: IssueStatus,
  issueIds: string[],
  claimed: Array<{ id: string }>,
): Promise<ClaimConflictError> {
  const lost = issueIds.filter((id) => !claimed.some((r) => r.id === id));
  const conflicts = await readClaimConflicts(projectId, gateStatus, lost);
  return new ClaimConflictError(
    lost,
    conflicts.length > 0 ? claimConflictDetails(projectId, gateStatus, conflicts) : null,
  );
}

export interface ClaimConflictDetails {
  [key: string]: unknown;
  issueIds: string[];
  conflicts: ClaimConflict[];
  projectId: string;
  gateStatus: string;
}

/** The refusal's details, which is where its sentence is composed from at every door. */
export function claimConflictDetails(
  projectId: string,
  gateStatus: string,
  conflicts: ClaimConflict[],
): ClaimConflictDetails {
  return { issueIds: conflicts.map((c) => c.id), conflicts, projectId, gateStatus };
}

/** The details, read back off a blocker's; `null` where they carry no standings to compose from. */
export function readClaimConflictDetails(
  details: Record<string, unknown> | undefined,
): ClaimConflictDetails | null {
  const conflicts = details?.conflicts;
  if (!Array.isArray(conflicts) || conflicts.length === 0) return null;
  if (typeof details?.projectId !== 'string' || typeof details.gateStatus !== 'string') return null;
  return details as ClaimConflictDetails;
}
