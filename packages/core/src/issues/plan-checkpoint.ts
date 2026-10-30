/**
 * The plan checkpoint build waits for (REQ-2 BC-4; issue-lifecycle, the back edge design-check ->
 * in_progress "build may start"): where gate `plan_approval` is enforced (REQ-76: strict, or
 * standard's `plan.approval.required`), the work reaches build only once the issue passed `approved`
 * since its plan was last written. The status move into approved asks `plans.approve`
 * (`transition-guards.ts:planGuard`); this is the other half, asked where the work moves into build:
 * the work step's write (`update-service.ts`) and a claim's resume (`apply-transition.ts:stepAfter`).
 *
 * "Since its plan was last written" reads `issues.plan_written_at`, which a trigger stamps on every
 * write that changes the plan (migration 0544), against the newest recorded move to `approved`: a
 * `kernel_transitions` row, or the `issue.statusChanged` feed row that was the only record of an
 * issue's move before migration 0303 audited issues there. An issue standing at `approved` whose move
 * there neither holds got there no earlier than its create or its newest recorded move, and passed
 * the checkpoint where its plan was written no later than that. Where the gate is off or the project
 * relaxes it, nothing is asked.
 *
 * Before either, an issue delivering a requirement reaches build only with a plan written against a
 * revision of it (`unplannedForBuild`, ISS-778): the draft opened against the requirement's current
 * revision without one (`checklist-record.ts:plannedAgainst`), since the plan is the run's to write.
 * It is asked where gate `design_record` is enforced, at the same doors as the design check.
 */

import type { ResolvedGate } from '@forge/contracts/gate-profiles';
import type { IssueUpdateRefusalCode } from '@forge/contracts/issues';
import { requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';
import { gateRefusal } from '../lib/gated.js';
import { RefusalError } from '../lib/refusal.js';
import { isBlankPlan } from './transition-evidence.js';

type Reader = Pick<Tx, 'execute'>;

const PENDING = 'PLAN_APPROVAL_PENDING' satisfies IssueUpdateRefusalCode;
const REQUIRED = 'PLAN_REQUIRED' satisfies IssueUpdateRefusalCode;

/** Where the issue stands against the checkpoint: when its plan was written and when it last passed approved. */
export interface PlanCheckpoint {
  passed: boolean;
  /** Whether the issue holds a plan now: approved asks for one (PLAN_REQUIRED). */
  hasPlan: boolean;
  planWrittenAt: Date | null;
  approvedAt: Date | null;
}

export async function planCheckpointOf(executor: Reader, issueId: string): Promise<PlanCheckpoint> {
  // compared in SQL: a JS Date keeps milliseconds, the columns keep microseconds
  const row = rowsOf<{
    plan: string | null;
    plan_written_at: Date | string | null;
    approved_at: Date | string | null;
    passed: boolean | null;
  }>(
    await executor.execute(sql`
      SELECT a.plan, a.plan_written_at, a.approved_at,
             (a.plan_written_at IS NOT NULL AND (
                a.approved_at > a.plan_written_at
                OR (a.approved_at IS NULL AND a.status = 'approved'
                    AND a.plan_written_at <= GREATEST(a.created_at, a.moved_at)))) AS passed
        FROM (SELECT i.plan, i.plan_written_at, i.status, i.created_at,
                     GREATEST(
                       (SELECT max(k.created_at) FROM kernel_transitions k
                         WHERE k.entity = 'issue' AND k.entity_id = i.id
                           AND k.to_status = 'approved'),
                       (SELECT max(f.created_at) FROM activity_log f
                         WHERE f.issue_id = i.id AND f.action = 'issue.statusChanged'
                           AND f.payload ->> 'to' = 'approved')) AS approved_at,
                     GREATEST(
                       (SELECT max(k.created_at) FROM kernel_transitions k
                         WHERE k.entity = 'issue' AND k.entity_id = i.id),
                       (SELECT max(f.created_at) FROM activity_log f
                         WHERE f.issue_id = i.id AND f.action = 'issue.statusChanged')) AS moved_at
                FROM issues i WHERE i.id = ${issueId}) a
    `),
  )[0];
  // no plan written is no pass: approved asks for one (PLAN_REQUIRED), so the work waits there
  const hasPlan = !isBlankPlan(row?.plan);
  return {
    passed: hasPlan && row?.passed === true,
    hasPlan,
    planWrittenAt: asDate(row?.plan_written_at),
    approvedAt: asDate(row?.approved_at),
  };
}

/** Whether the work may enter build as far as this gate goes: off, or the checkpoint passed. */
export async function planCheckpointHolds(
  executor: Reader,
  issueId: string,
  gate: ResolvedGate,
): Promise<boolean> {
  if (gate.mode !== 'enforce') return true;
  return (await planCheckpointOf(executor, issueId)).passed;
}

/** Refuses the move of the work into `step` (build, test or release) until the checkpoint is passed. */
export async function refusePlanUnapprovedForBuild(
  executor: Reader,
  issueId: string,
  gate: ResolvedGate,
  step: WorkStep,
): Promise<void> {
  if (gate.mode !== 'enforce') return;
  const at = await planCheckpointOf(executor, issueId);
  if (at.passed) return;
  // the owed act first: a plan where none stands, else the approval of the one that does
  const detail = !at.hasPlan
    ? `\`${step}\` waits for a plan: the issue has no plan. Write one, then a holder of plans.approve approves it.`
    : at.approvedAt === null
      ? `\`${step}\` waits for plan approval: a holder of plans.approve moves the issue to \`approved\` first.`
      : `\`${step}\` waits for plan approval: the plan changed after \`approved\`, so a holder of plans.approve approves it again.`;
  const refusal = gateRefusal(gate, { code: PENDING, path: '/workState/step', detail });
  throw new RefusalError([refusal], PENDING);
}

/**
 * Why `step` (build, test or release) waits for a plan written against the requirement the issue
 * delivers, or null: it delivers none, or its plan names a revision of it.
 */
export async function unplannedForBuild(
  executor: Reader,
  issueId: string,
  step: WorkStep,
): Promise<string | null> {
  const row = rowsOf<{
    req_seq: number;
    current_revision: number | null;
    planned_revision: number | null;
    plan: string | null;
  }>(
    await executor.execute(sql`
      SELECT r.req_seq, r.current_revision, i.planned_revision, i.plan
        FROM issues i JOIN requirements r ON r.id = i.requirement_id
       WHERE i.id = ${issueId}
    `),
  )[0];
  if (!row) return null;
  const hasPlan = !isBlankPlan(row.plan);
  if (hasPlan && row.planned_revision !== null) return null;
  const key = requirementKey(Number(row.req_seq));
  const records =
    row.current_revision === null
      ? `${key} has no current revision to write it against, so a person accepts one first.`
      : `saving it records ${key} revision ${row.current_revision} as the one it is written against.`;
  return hasPlan
    ? `\`${step}\` waits for a plan written against ${key}: the issue's plan was saved before it was linked to ${key}, so it names no revision. Save the plan again (PATCH /api/issues/:id {plan}); ${records}`
    : `\`${step}\` waits for a plan: the issue delivers ${key} and has no plan yet. Write it (PATCH /api/issues/:id {plan}); ${records}`;
}

/** Refuses the move of the work into `step` while `unplannedForBuild` names a missing plan. */
export async function refuseUnplannedForBuild(
  executor: Reader,
  issueId: string,
  gate: ResolvedGate,
  step: WorkStep,
): Promise<void> {
  if (gate.mode !== 'enforce') return;
  const detail = await unplannedForBuild(executor, issueId, step);
  if (detail === null) return;
  const refusal = gateRefusal(gate, { code: REQUIRED, path: '/plan', detail });
  throw new RefusalError([refusal], REQUIRED);
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}
