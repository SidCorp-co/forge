// A verdict is recorded as the judgement of the role its run was declared as. A run declared
// `--role qa` judges on the running build and one declared `--role reviewer` judges a code property
// against the diff (`issue-resting.ts:JUDGING_RUN_ROLES`); the `judge` a verdict carries is the
// run's own, never a label it picks. Without this a `qa` run refused a code-property criterion
// (`VERDICT_JUDGED_BY_REVIEW`) had only to send `judge: "review"` to record the review's verdict
// itself, and the record would say a review judged what no review read (`VISION: state-never-lies`).

import { RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type { CriterionJudge } from '@forge/contracts/issue-design';
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { judgeOfRole } from '../issue-resting.js';
import type { VerdictRefusal } from './verdict-input.js';

const JUDGE_LABEL: Record<CriterionJudge, string> = {
  qa: "QA's, on the running build",
  review: "the review's, against the diff",
};

const RECORDED_AS: Record<CriterionJudge, string> = {
  qa: 'omit `judge`',
  review: 'send `judge: "review"`',
};

const ROLE_OF: Record<CriterionJudge, string> = { qa: 'qa', review: 'reviewer' };

interface DeclaredRow {
  role: string | null;
  box_run_id: string | null;
}

/**
 * Where the run session recording a verdict was declared under a judging role whose judge is not the
 * verdict's, the refusal naming both and the run that may record it; null for any other session, a
 * building role's, or a run declared with no role (the declaration before roles, `run-take.ts`).
 */
export async function judgeRoleFault(
  tx: Pick<Tx, 'execute'>,
  args: {
    session: string | null;
    criterion: number;
    judge: CriterionJudge;
    /** The judge the criterion's class routes it to; null where its design classes it nowhere. */
    routed: CriterionJudge | null;
  },
): Promise<VerdictRefusal | null> {
  if (args.session === null) return null;
  const [row] = (await tx.execute(sql`
    SELECT r.metadata ->> 'role' AS role, r.metadata ->> 'boxRunId' AS box_run_id
      FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.id = ${args.session} AND s.kind = ${RUN_SESSION_KIND}
  `)) as unknown as DeclaredRow[];
  const role = row?.role ?? null;
  const declared = role === null ? null : judgeOfRole(role);
  if (declared === null || declared === args.judge) return null;
  const run = row?.box_run_id ?? args.session;
  const own =
    args.routed === null ? `, or record it as this run's own (${RECORDED_AS[declared]})` : '';
  return {
    code: 'VERDICT_JUDGE_NOT_RUN_ROLE',
    criterion: args.criterion,
    path: '/judge',
    detail: `criterion ${args.criterion}'s verdict is sent as ${JUDGE_LABEL[args.judge]}, by run ${run}, which was declared \`--role ${role}\` and so judges as ${JUDGE_LABEL[declared]}. A run records only its own role's judgement: declare a \`--role ${ROLE_OF[args.judge]}\` run to record this one (over an issue that is closed too, carried untaken)${own}. Nothing was written.`,
  };
}
