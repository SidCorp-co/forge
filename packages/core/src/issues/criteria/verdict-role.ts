// A verdict is recorded as the judgement of the role its run was declared as. A run declared
// `--role qa` judges on the running build and one declared `--role reviewer` judges a code property
// against the diff (`issue-resting.ts:JUDGING_RUN_ROLES`); the `judge` a verdict carries is the
// run's own, never a label it picks. Without this a `qa` run refused a code-property criterion
// (`VERDICT_JUDGED_BY_REVIEW`) had only to send `judge: "review"` to record the review's verdict
// itself, and the record would say a review judged what no review read (`VISION: state-never-lies`).
// A comment's verdict fence names its judge on a `judge:` line, and one naming none is the recording
// run's own role's; it once dropped the line, so a reviewer run's fence was recorded as QA's and
// refused here with nothing it could send to fix it (ISS-1021).

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

/**
 * The two doors a verdict names its judge at: a comment's verdict fence, by its `judge:` line, and
 * the REST door, by its `judge` field. Every refusal about a judge names both, so a run told to
 * send one is never told of a door that would drop it (ISS-1021).
 */
export function judgeDoors(judge: CriterionJudge): string {
  return `\`judge: ${judge}\` in a comment's verdict fence, or \`"judge": "${judge}"\` at \`POST /api/issues/:id/verdicts\``;
}

const ROLE_OF: Record<CriterionJudge, string> = { qa: 'qa', review: 'reviewer' };

interface DeclaredRow {
  role: string | null;
  box_run_id: string | null;
}

/** The run a session was declared as: its role, the judge that role records as, and its name. */
export interface DeclaredRun {
  readonly role: string;
  /** Null for a role that builds (`issue-resting.ts:judgeOfRole`). */
  readonly judge: CriterionJudge | null;
  /** The run as its box names it, else the session. */
  readonly run: string;
}

/**
 * The role the run session recording a verdict was declared under, read off its run; null for a
 * session that is no run's, or a run declared with no role (the declaration before roles,
 * `run-take.ts`). Every judge a verdict is recorded as is asked of this one read.
 */
export async function declaredRunOf(
  tx: Pick<Tx, 'execute'>,
  session: string | null,
): Promise<DeclaredRun | null> {
  if (session === null) return null;
  const [row] = (await tx.execute(sql`
    SELECT r.metadata ->> 'role' AS role, r.metadata ->> 'boxRunId' AS box_run_id
      FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.id = ${session} AND s.kind = ${RUN_SESSION_KIND}
  `)) as unknown as DeclaredRow[];
  if (!row?.role) return null;
  return { role: row.role, judge: judgeOfRole(row.role), run: row.box_run_id ?? session };
}

/**
 * Where the run recording a verdict was declared under a judging role whose judge is not the
 * verdict's, the refusal naming both, the run that may record it and the two doors that take a
 * judge; null for any other run, a building role's, or none.
 */
export function judgeRoleFault(
  declared: DeclaredRun | null,
  args: {
    criterion: number;
    judge: CriterionJudge;
    /** The judge the criterion's class routes it to; null where its design classes it nowhere. */
    routed: CriterionJudge | null;
  },
): VerdictRefusal | null {
  if (declared === null || declared.judge === null || declared.judge === args.judge) return null;
  const own =
    args.routed === null
      ? `, or record it as this run's own judgement with ${judgeDoors(declared.judge)}`
      : '';
  return {
    code: 'VERDICT_JUDGE_NOT_RUN_ROLE',
    criterion: args.criterion,
    path: '/judge',
    detail: `criterion ${args.criterion}'s verdict is sent as ${JUDGE_LABEL[args.judge]}, by run ${declared.run}, which was declared \`--role ${declared.role}\` and so judges as ${JUDGE_LABEL[declared.judge]}. A run records only its own role's judgement: declare a \`--role ${ROLE_OF[args.judge]}\` run to record this one with ${judgeDoors(args.judge)} (over an issue that is closed too, carried untaken)${own}. A verdict fence with no \`judge:\` line is recorded as its run's own role's. Nothing was written.`,
  };
}
