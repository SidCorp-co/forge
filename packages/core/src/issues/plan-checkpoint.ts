/**
 * The plan checkpoint build waits for (REQ-2 BC-4; issue-lifecycle, the back edge design-check ->
 * in_progress "build may start"): where gate `plan_approval` is enforced (REQ-76: strict, or
 * standard's `plan.approval.required`), the work reaches build only once the issue passed `approved`
 * since its plan was last written. The status move into approved asks `plans.approve`
 * (`transition-guards.ts:planGuard`); this is the other half, asked where the work moves into build:
 * the work step's write (`update-service.ts`) and a claim's resume (`apply-transition.ts:stepAfter`).
 *
 * "Since its plan was last written" reads `issues.plan_written_at`, which a trigger stamps on every
 * write that changes the plan (migration 0544), against the newest `kernel_transitions` row moving
 * the issue to `approved`. Where the gate is off or the project relaxes it, nothing is asked.
 */

import type { ResolvedGate } from '@forge/contracts/gate-profiles';
import type { IssueUpdateRefusalCode } from '@forge/contracts/issues';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { gateRefusal } from '../lib/gated.js';
import { RefusalError } from '../lib/refusal.js';

type Reader = Pick<Tx, 'execute'>;

const PENDING = 'PLAN_APPROVAL_PENDING' satisfies IssueUpdateRefusalCode;

/** Where the issue stands against the checkpoint: when its plan was written and when it last passed approved. */
export interface PlanCheckpoint {
  passed: boolean;
  planWrittenAt: Date | null;
  approvedAt: Date | null;
}

export async function planCheckpointOf(executor: Reader, issueId: string): Promise<PlanCheckpoint> {
  // compared in SQL: a JS Date keeps milliseconds, the columns keep microseconds
  const row = rowsOf<{
    plan_written_at: Date | string | null;
    approved_at: Date | string | null;
    passed: boolean | null;
  }>(
    await executor.execute(sql`
      SELECT a.plan_written_at, a.approved_at,
             (a.approved_at IS NOT NULL AND a.plan_written_at IS NOT NULL
              AND a.approved_at > a.plan_written_at) AS passed
        FROM (SELECT i.plan_written_at,
                     (SELECT max(k.created_at) FROM kernel_transitions k
                       WHERE k.entity = 'issue' AND k.entity_id = i.id
                         AND k.to_status = 'approved') AS approved_at
                FROM issues i WHERE i.id = ${issueId}) a
    `),
  )[0];
  // no plan written is no pass: approved asks for one (PLAN_REQUIRED), so the work waits there
  return {
    passed: row?.passed === true,
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

/** Refuses the move of the work into build, test or release until the checkpoint is passed. */
export async function refusePlanUnapprovedForBuild(
  executor: Reader,
  issueId: string,
  gate: ResolvedGate,
): Promise<void> {
  if (gate.mode !== 'enforce') return;
  const at = await planCheckpointOf(executor, issueId);
  if (at.passed) return;
  const since =
    at.approvedAt === null
      ? 'it has not passed `approved`'
      : 'its plan was rewritten after it last passed `approved`';
  const refusal = gateRefusal(gate, {
    code: PENDING,
    path: '/workState/step',
    detail: `build starts only once a holder of plans.approve has moved the issue to \`approved\` since its plan was last written, and ${since}. Ask for it: park at \`needs_info\` with \`waitingKind: "needs_decision"\` naming the plan, or have a holder of plans.approve move it.`,
  });
  throw new RefusalError([refusal], PENDING);
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}
