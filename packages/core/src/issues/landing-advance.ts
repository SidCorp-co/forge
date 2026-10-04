// cm:why a recorded landing is the last act of the work it records, so the issue moves where workflow
// `issue-lifecycle` rev 3 puts landed work: edge `verdicts.passed` (in_progress -> awaiting_release)
// where every criterion already passes, else the run step after the landing (`test`, inside
// in_progress) where a judge records the verdicts. It never takes edge `shipped` (in_progress ->
// closed): closing is the release step, and a close needs the verdicts (ISS-96). ISS-80.

import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { guideRef } from '../guides/guide-ref.js';
import { leaseHolderOf } from '../pipeline/session-claim.js';
import type { TransitionActor } from './actor-agency.js';
import { TransitionError, transitionIssueStatus } from './apply-transition.js';
import { issueWorkInFlightSql } from './issue-lease.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import type { GuardCode } from './transition-guards.js';
import { readWorkState, setWorkStep } from './work-state.js';

export const LANDING_JUDGE_STEP = 'test' as const;

export type LandingAdvance =
  | { outcome: 'left_to_run'; status: IssueStatus; leaseEnded: string | null; detail: string }
  | {
      outcome: 'awaiting_release';
      status: 'awaiting_release';
      leaseEnded: string | null;
      detail: string;
    }
  | {
      outcome: 'judge_owed';
      status: 'in_progress';
      step: typeof LANDING_JUDGE_STEP;
      leaseEnded: string | null;
      detail: string;
    }
  | {
      outcome: 'unmoved';
      status: IssueStatus;
      leaseEnded: string | null;
      detail: string;
      refusal?: { code: string; detail: string };
    };

const VERDICT_SHORT: ReadonlySet<GuardCode> = new Set([
  'NO_WORK_EVIDENCE',
  'VERDICT_IDENTITY_REQUIRED',
  'VERDICT_PREDATES_REOPEN',
  'VERDICT_IDENTITY_NOT_ADMISSIBLE',
  'VERDICT_UNCORROBORATED',
  'VERDICT_DRAFT_SUPERSEDED',
]);

const UNMOVED_BECAUSE: Partial<Record<IssueStatus, string>> = {
  draft:
    'it stays `draft`: work landed on an issue nobody admitted, and admitting it is a person’s act (`draft -> open`)',
  open: 'it stays `open`: the lifecycle enters `in_progress` only by a claim (NO_HOLDER), so the run that claims it next judges what landed',
  reopen:
    'it stays `reopen`: a person sent it back, and the run that claims it next judges what landed against the reopen reason',
  approved:
    'it stays `approved`: the run that claims the plan checkpoint next judges what landed rather than building it',
  needs_info:
    'it stays `needs_info`: a person owes an answer, which returns it to the status it left',
  on_hold:
    'it stays `on_hold`: a person paused it, and lifting the pause returns it to the status it left',
  awaiting_release: 'it is already `awaiting_release`, where landed work waits for its release',
  closed: 'it is already `closed`',
  dropped: 'it is `dropped`, which nothing leaves',
};

class RunTookTheIssue extends Error {}

const IN_FLIGHT = 'in_flight' as const;

// cm:guard asked inside every transaction that writes, after the issue row is locked, the way a
// recovery move asks `issueHolder` (`apply-transition.ts`): a run that takes the issue between two
// of this module's writes keeps it, and nothing after that point is written over it.
async function runInFlight(executor: Pick<Tx, 'execute'>, issueId: string): Promise<boolean> {
  const rows = (await executor.execute(sql`
    SELECT ${issueWorkInFlightSql({
      issueId: sql`i.id`,
      projectId: sql`i.project_id`,
      issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
    })} AS held
      FROM issues i WHERE i.id = ${issueId}
  `)) as unknown as Array<{ held: boolean }>;
  return rows[0]?.held === true;
}

// cm:guard the stamp goes on the lease value read under the row lock, as the strand sweep's release
// does (`pipeline/idle-issues.ts:writeStrand`), so a claim written between the read and the write wins.
async function endWorkStateLease(
  issueId: string,
  status: IssueStatus,
  now: Date,
): Promise<string | null | typeof IN_FLIGHT> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM issues WHERE id = ${issueId} FOR UPDATE`);
    if (await runInFlight(tx, issueId)) return IN_FLIGHT;
    const held = await readWorkState(tx, issueId);
    const lease = held?.lease;
    if (typeof lease !== 'object' || lease === null || Array.isArray(lease)) return null;
    if ((lease as Record<string, unknown>).stopped != null) return null;
    const holder = leaseHolderOf(lease);
    const entry = JSON.stringify({ at: now.toISOString(), how: 'landed', holder, status });
    await tx.execute(sql`
      UPDATE issue_work_state w
         SET lease = jsonb_set(
               jsonb_set(w.lease, '{stopped}', to_jsonb(${now.toISOString()}::text), true),
               '{history}',
               (CASE WHEN jsonb_typeof(w.lease -> 'history') = 'array'
                     THEN w.lease -> 'history' ELSE '[]'::jsonb END) || ${entry}::jsonb,
               true),
             updated_at = now()
       WHERE w.issue_id = ${issueId} AND jsonb_typeof(w.lease) = 'object'
    `);
    return holder ?? 'a holder the lease does not name';
  });
}

async function moveToJudgeStep(issueId: string): Promise<boolean | typeof IN_FLIGHT> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.status, 'in_progress')))
      .for('update')
      .limit(1);
    if (!row) return false;
    if (await runInFlight(tx, issueId)) return IN_FLIGHT;
    await setWorkStep(tx, issueId, LANDING_JUDGE_STEP);
    await tx.update(issues).set({ updatedAt: sql`now()` }).where(eq(issues.id, issueId));
    return true;
  });
}

function leaseClause(leaseEnded: string | null): string {
  return leaseEnded ? ` The lease held by ${leaseEnded} was ended by the landing.` : '';
}

function leftToRun(status: IssueStatus, leaseEnded: string | null): LandingAdvance {
  return {
    outcome: 'left_to_run',
    status,
    leaseEnded,
    detail: `A run is in flight on this issue (a live job, pipeline run or fleet lease), so the landing is that run’s act: its status (\`${status}\`) and its hold are left to it.${leaseClause(leaseEnded)}`,
  };
}

export async function advanceLandedIssue(args: {
  issue: { id: string; projectId: string; status: IssueStatus; reopenCount: number };
  actor: TransitionActor;
  now?: Date;
}): Promise<LandingAdvance> {
  const { issue, actor } = args;
  const now = args.now ?? new Date();
  const ended = await endWorkStateLease(issue.id, issue.status, now);
  if (ended === IN_FLIGHT) return leftToRun(issue.status, null);
  const leaseEnded = ended;
  if (issue.status !== 'in_progress') {
    if (leaseEnded) await publishPipelineHealthChanged(issue.projectId, [issue.id]);
    return {
      outcome: 'unmoved',
      status: issue.status,
      leaseEnded,
      detail: `Landing recorded; ${UNMOVED_BECAUSE[issue.status] ?? `\`${issue.status}\` has no landing move`}.${leaseClause(leaseEnded)}`,
    };
  }
  try {
    const moved = await transitionIssueStatus(issue, 'awaiting_release', actor, {
      reason: 'landing_recorded',
      beforeStatusWrite: async (tx) => {
        if (await runInFlight(tx, issue.id)) throw new RunTookTheIssue();
      },
    });
    const held = moved.verdictsWaived
      ? 'this project does not require verdicts to reach the gate (`delivery.verdictsRequired: false`), and the move is recorded as `verdicts-waived`'
      : 'every criterion already holds a passing verdict';
    return {
      outcome: 'awaiting_release',
      status: 'awaiting_release',
      leaseEnded,
      detail: `Landing recorded and ${held}, so it moved \`in_progress\` -> \`awaiting_release\` (${guideRef('pipeline-and-issue-lifecycle')}).${leaseClause(leaseEnded)}`,
    };
  } catch (err) {
    if (err instanceof RunTookTheIssue) return leftToRun(issue.status, leaseEnded);
    if (!(err instanceof TransitionError)) throw err;
    if (!VERDICT_SHORT.has(err.code as GuardCode)) {
      return {
        outcome: 'unmoved',
        status: issue.status,
        leaseEnded,
        detail: `Landing recorded, and the move to \`awaiting_release\` was refused for a reason other than its verdicts, so it stays \`in_progress\` where it was.${leaseClause(leaseEnded)}`,
        refusal: { code: err.code, detail: err.detail },
      };
    }
  }
  const stepped = await moveToJudgeStep(issue.id);
  if (stepped === IN_FLIGHT) return leftToRun(issue.status, leaseEnded);
  if (!stepped) {
    return {
      outcome: 'unmoved',
      status: issue.status,
      leaseEnded,
      detail: `Landing recorded, and the issue left \`in_progress\` while it was being moved, so no step was written.${leaseClause(leaseEnded)}`,
      refusal: { code: 'STALE_TRANSITION', detail: 'issue status changed concurrently' },
    };
  }
  await publishPipelineHealthChanged(issue.projectId, [issue.id]);
  return {
    outcome: 'judge_owed',
    status: 'in_progress',
    step: LANDING_JUDGE_STEP,
    leaseEnded,
    detail: `Landing recorded and not every criterion holds a passing verdict, so it waits at \`in_progress\`, step \`${LANDING_JUDGE_STEP}\`, for a judge to record them; \`awaiting_release\` follows once each passes (${guideRef('pipeline-and-issue-lifecycle')}).${leaseClause(leaseEnded)}`,
  };
}
