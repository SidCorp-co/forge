// Why each issue a release was asked to claim could not be claimed, and what frees it. The one
// sentence `CLAIM_CONFLICT` answers from every door — the batch, the record, the race at the claim.

import { TERMINAL_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns, projects } from '../db/schema.js';
import {
  claimIssuesForRelease,
  releasedSql,
  releaseRunClaims,
  waitingAtSql,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { agrees, counted } from '../lib/plural.js';
import { closeRunIfOneShot, writeRunMetadata } from '../pipeline/index.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { blockerRefusal, reasonOf, refuseRelease } from './refuse.js';
import { RELEASE_RECORD_SOURCE } from './version-rule.js';

/**
 * Inside the close's own transaction: refuses unless `runId` still claims the issue, holding the
 * row so an abort's release of the claim waits for this close or lands before it is read.
 */
export async function refuseLostReleaseClaim(
  tx: Tx,
  issueId: string,
  runId: string,
): Promise<void> {
  const held = await tx.execute(
    sql`SELECT 1 FROM issues WHERE id = ${issueId} AND release_batch_run_id = ${runId} FOR UPDATE`,
  );
  if (held.length === 0) {
    throw refuseRelease(
      'RELEASE_CLAIM_LOST',
      `release batch ${runId} no longer claims issue ${issueId}: an abort handed it back to the gate, so this finish does not close it`,
    );
  }
}

export { RELEASE_RECORD_SOURCE };

/** One refused issue. `key` is its `ISS-nn`, or the id as sent where no issue on the project has it. */
type ClaimConflict =
  | {
      id: string;
      key: string;
      standing: 'claimed';
      runId: string;
      runEnded: boolean;
      claimer: 'batch' | 'record';
      status: IssueStatus;
      /** At the gate with its run's step at `release`: held mid-release (it was `releasing`). */
      releasing: boolean;
    }
  | {
      id: string;
      key: string;
      standing: 'status';
      status: IssueStatus;
      /** Where `closed`: whether a shipped release already holds its work (`releasedSql`). */
      released?: boolean;
    }
  | { id: string; key: string; standing: 'absent' };

/**
 * The standing of each of `issueIds` that a release on `projectId` cannot claim. A claim is the
 * standing only where releasing it could leave the issue claimable — waiting for a release
 * (`waitingAtSql`: at the gate, or closed met in scope with no shipped release holding it), whether
 * or not a release still holds it at its `release` step (the old `releasing`, ISS-54). Anywhere else
 * the status bars it, whatever run claims it.
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
      runSource: sql<string | null>`${pipelineRuns.metadata} ->> 'source'`,
      waiting: sql<boolean>`${waitingAtSql(sql`${issues}`, gateStatus)}`,
      released: sql<boolean>`${releasedSql(sql`${issues}.id`, sql`${issues}.project_id`)}`,
      step: sql<
        string | null
      >`(SELECT w.step FROM issue_work_state w WHERE w.issue_id = ${issues.id})`,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds)));
  // A uuid is one id in either letter case; the rows carry it lower-case.
  const found = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const ended = new Set<string>(TERMINAL_PIPELINE_RUN_STATUSES);
  const seen = new Set<string>();
  const out: ClaimConflict[] = [];
  for (const sent of issueIds) {
    if (seen.has(sent.toLowerCase())) continue;
    seen.add(sent.toLowerCase());
    const row = found.get(sent.toLowerCase());
    if (!row) {
      out.push({ id: sent, key: sent, standing: 'absent' });
      continue;
    }
    const id = row.id;
    const key = formatIssueRef(row.issuePrefix, row.issSeq);
    if (row.claimed !== null && row.waiting) {
      out.push({
        id,
        key,
        standing: 'claimed',
        runId: row.claimed,
        runEnded: row.runStatus === null || ended.has(row.runStatus),
        claimer: row.runSource === RELEASE_RECORD_SOURCE ? 'record' : 'batch',
        status: row.status,
        releasing: row.step === 'release',
      });
    } else if (!row.waiting) {
      out.push({
        id,
        key,
        standing: 'status',
        status: row.status,
        ...(row.status === 'closed' ? { released: row.released } : {}),
      });
    }
  }
  return out;
}

function keys(list: ClaimConflict[]): string {
  return list.map((c) => c.key).join(', ');
}

function isAre(list: unknown[]): string {
  return agrees(list.length, 'is', 'are');
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

function running(projectId: string, runId: string, list: Standing<'claimed'>[]): string {
  const subject = `${keys(list)} ${isAre(list)} claimed by`;
  if (list[0]?.claimer === 'record') {
    return `${subject} release record ${runId}, which another caller is recording now: read it with GET /api/projects/${projectId}/release-records/${runId}. The record closes what it carries, and an issue it could not close comes free once it ends.`;
  }
  return `${subject} release batch ${runId}, which is still running: read where it stands with GET /api/projects/${projectId}/release-batches/${runId}/state. An issue comes free once that batch releases its claim.`;
}

function claimedSentences(projectId: string, runId: string, list: Standing<'claimed'>[]): string[] {
  if (!list.some((c) => c.runEnded)) return [running(projectId, runId, list)];
  const out: string[] = [];
  const held = list.filter((c) => c.releasing);
  const stale = list.filter((c) => !c.releasing);
  if (held.length > 0) {
    const them = agrees(held.length, 'it', 'them');
    out.push(
      `${keys(held)} ${isAre(held)} at \`awaiting_release\` held at the release step, still claimed by release batch ${runId}, which has ended: abort it with POST /api/projects/${projectId}/release-batches/${runId}/abort and a body of {"promotedRoster":"return-to-gate"}, which releases the claim and puts ${them} back at the release gate, then send ${them} again.`,
    );
  }
  if (stale.length > 0) {
    const kind = stale[0]?.claimer === 'record' ? 'release record' : 'release batch';
    const them = agrees(stale.length, 'it', 'them');
    out.push(
      `${keys(stale)} ${isAre(stale)} still claimed by ${kind} ${runId}, which has ended: the pipeline sweep clears a claim an ended run left on an issue at the release gate, once a minute, so send ${them} again after it has run.`,
    );
  }
  return out;
}

function statusSentence(
  projectId: string,
  status: string,
  gateStatus: string,
  list: ClaimConflict[],
): string {
  const subject = `${keys(list)} ${isAre(list)} at \`${status}\``;
  if (status === 'closed') return closedSentences(list);
  if (status === 'dropped') {
    return `${subject}: set down as not work, so no release carries ${agrees(list.length, 'it', 'them')}.`;
  }
  if (status === 'draft') {
    return `${subject}, not \`${gateStatus}\`: a release carries an issue only once it reaches the release gate. A draft filed for a merge its project owed a filing for, marked merged at that merge, is recorded on the shipped release that already holds it instead: POST /api/projects/${projectId}/shipped-in-records { issueId, version, evidence }, which closes it from \`draft\`.`;
  }
  return `${subject}, not \`${gateStatus}\`: a release carries an issue only once it reaches the release gate.`;
}

/**
 * Closed issues no release may claim: those a shipped release already holds, and those closed with
 * nothing a release carries. A closed issue met in scope that no release holds yet is on the roster
 * (`waitingAtSql`), so it never reaches here.
 */
function closedSentences(list: ClaimConflict[]): string {
  const released = list.filter((c) => c.standing === 'status' && c.released === true);
  const rest = list.filter((c) => !(c.standing === 'status' && c.released === true));
  const out: string[] = [];
  if (released.length > 0) {
    const it = agrees(released.length, 'it', 'any of them');
    out.push(
      `${keys(released)} ${isAre(released)} \`closed\` and already released: a shipped release holds ${agrees(released.length, 'its', 'their')} work, and a release carries an issue once. If ${it} has to ship again, reopen it and bring it back through the pipeline to the release gate.`,
    );
  }
  if (rest.length > 0) {
    out.push(
      `${keys(rest)} ${isAre(rest)} \`closed\` with nothing a release carries: design-only, adoption-only, closed with no merge recorded, or closed before its holder could close it met in scope, which keeps what it holds.`,
    );
  }
  return out.join(' ');
}

/** The refusal, one sentence per reason, each naming its issues by key. */
export function claimConflictSentence(
  projectId: string,
  gateStatus: string,
  conflicts: ClaimConflict[],
): string {
  const n = conflicts.length;
  const parts = [`${counted(n, 'issue')} named here cannot be claimed for a release.`];
  for (const [runId, list] of groupBy(ofStanding(conflicts, 'claimed'), (c) => c.runId)) {
    parts.push(...claimedSentences(projectId, runId, list));
  }
  for (const [status, list] of groupBy(ofStanding(conflicts, 'status'), (c) => c.status)) {
    parts.push(statusSentence(projectId, status, gateStatus, list));
  }
  const absent = ofStanding(conflicts, 'absent');
  if (absent.length > 0) {
    parts.push(
      `${keys(absent)} ${agrees(absent.length, 'is no issue', 'are no issues')} on this project.`,
    );
  }
  return parts.join(' ');
}

/**
 * The roster claimed onto `runId`. A roster another caller claimed first cancels the run and
 * refuses `CLAIM_CONFLICT`, naming who holds each issue it lost. The issues it claimed already
 * `closed` (met in scope, no shipped release holding them) are named on the run as `carriedClosed`:
 * the release carries them without closing them, so nothing reads them as closed by it.
 */
export async function claimRoster(
  projectId: string,
  issueIds: string[],
  runId: string,
): Promise<Array<{ id: string; status: string }>> {
  const gateStatus = RELEASE_GATE_STATUS;
  const claimed = await claimIssuesForRelease({ projectId, issueIds, gateStatus, runId });
  if (claimed.length === issueIds.length) {
    const carried = claimed.filter((r) => r.status === 'closed').map((r) => r.id);
    if (carried.length > 0) {
      await writeRunMetadata(runId, { merge: { carriedClosed: carried }, touch: false });
    }
    return claimed;
  }
  await releaseRunClaims(runId);
  const lost = issueIds.filter((id) => !claimed.some((r) => r.id === id));
  const conflicts = await readClaimConflicts(projectId, gateStatus, lost);
  const refused = blockerRefusal(
    'CLAIM_CONFLICT',
    conflicts.length > 0
      ? claimConflictDetails(projectId, gateStatus, conflicts)
      : { issueIds: lost },
  );
  // the cut already wears its version: it ends `failed` naming the refusal, never a bare cancel (ISS-761)
  await closeRunIfOneShot(runId, 'failed', { code: 'CLAIM_CONFLICT', detail: reasonOf(refused) });
  throw refused;
}

interface ClaimConflictDetails {
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
