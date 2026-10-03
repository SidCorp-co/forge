/**
 * One guard per move of workflow `issue-lifecycle` (approved revision 2), each refusing by name.
 * `apply-transition.ts` asks `edgeFault` before anything is written and `guardFault` inside the
 * transition's own transaction, so a guard reads the row the move will change.
 *
 *   into               condition                                                code
 *   any (edge)         the move is an edge of the lifecycle                      ILLEGAL_TRANSITION
 *   in_progress        a run or lease holds it                                   NO_HOLDER
 *   approved           plan and criteria written; a person made the move where   PLAN_REQUIRED
 *                      the project document sets `plan.approval.required`
 *   awaiting_release   every criterion's latest verdict passes, with an          NO_WORK_EVIDENCE,
 *                      identity                                                  VERDICT_IDENTITY_REQUIRED
 *   closed             shipped (`merged-at.ts`, inside the write)                CLOSE_REQUIRES_SHIPPED
 *
 *   needs_info         a question (the reason) and its kind                      TRANSITION_REASON_REQUIRED,
 *                                                                                WAITING_KIND_REQUIRED
 *   on_hold, reopen    a reason                                                  TRANSITION_REASON_REQUIRED
 *   dropped            a reason                                                  VOID_REASON_REQUIRED
 */

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import {
  canTransition,
  PARK_STATUSES,
  parkExitTargets,
  transitions,
} from '../pipeline/state-machine.js';
import { readProjectDocument } from '../project-config/service.js';
import type { ActorAgency } from './actor-agency.js';
import { unpassedCriteria } from './release-evidence.js';
import { isBlankPlan } from './transition-evidence.js';
import { issueHolder } from './work-state.js';

export type GuardCode =
  | 'ILLEGAL_TRANSITION'
  | 'NO_HOLDER'
  | 'PLAN_REQUIRED'
  | 'NO_WORK_EVIDENCE'
  | 'VERDICT_IDENTITY_REQUIRED'
  | 'TRANSITION_REASON_REQUIRED'
  | 'WAITING_KIND_REQUIRED'
  | 'VOID_REASON_REQUIRED';

export interface GuardFault {
  code: GuardCode;
  detail: string;
  details: Record<string, unknown>;
}

const quote = (s: string) => `\`${s}\``;
const list = (statuses: readonly string[]) => statuses.map(quote).join(', ');

/** The edge check: whether `from → to` is a move of the lifecycle at all. */
export function edgeFault(args: {
  from: IssueStatus;
  to: IssueStatus;
  leftStatus: IssueStatus | null;
}): GuardFault | null {
  const { from, to, leftStatus } = args;
  if (canTransition(from, to, leftStatus)) return null;
  const allowed = PARK_STATUSES.includes(from)
    ? parkExitTargets(from, leftStatus)
    : transitions[from];
  const details = { from, to, allowed: [...allowed], leftStatus };
  if (PARK_STATUSES.includes(from) && leftStatus !== null) {
    return {
      code: 'ILLEGAL_TRANSITION',
      detail: `${quote(from)} returns to the status it left, which is ${quote(leftStatus)} — not ${quote(to)}. From here the moves are ${list(allowed)}.`,
      details,
    };
  }
  if (to === 'draft') {
    return {
      code: 'ILLEGAL_TRANSITION',
      detail: `${quote('draft')} is the status an issue is filed at and is never entered again. Use ${quote('on_hold')} to pause work, or ${quote('dropped')} for something that is not work.`,
      details,
    };
  }
  const exits = allowed.length === 0 ? 'none: it is terminal' : list(allowed);
  return {
    code: 'ILLEGAL_TRANSITION',
    detail: `${quote(from)} → ${quote(to)} is not a move of the issue lifecycle. From ${quote(from)} the moves are ${exits}.`,
    details,
  };
}

export interface GuardContext {
  issue: { id: string; projectId: string };
  from: IssueStatus;
  to: IssueStatus;
  /** The status the park being left was entered from (`issue_work_state.left_status`), or null. */
  leftStatus?: IssueStatus | null | undefined;
  agency: ActorAgency;
  transitionReason?: string | undefined;
  waitingKind?: WaitingKind | undefined;
  executor: Pick<Tx, 'select' | 'execute'>;
}

const hasText = (s: string | undefined) => Boolean(s?.trim());

/** Reasons and kinds: the guards that read only the request. Asked before the write begins. */
export function reasonFault(
  ctx: Omit<GuardContext, 'executor' | 'issue' | 'leftStatus'>,
): GuardFault | null {
  const details = { from: ctx.from, to: ctx.to };
  if (ctx.to === 'needs_info') {
    if (!hasText(ctx.transitionReason)) {
      return {
        code: 'TRANSITION_REASON_REQUIRED',
        detail:
          'a move to `needs_info` carries the question a person has to answer, as `reason`: nothing else tells them what they are being asked',
        details,
      };
    }
    if (!ctx.waitingKind) {
      return {
        code: 'WAITING_KIND_REQUIRED',
        detail:
          'a move to `needs_info` says what it is stopped on, as `waitingKind`: `needs_answer` (a question), `needs_decision` (a decision) or `needs_resource` (something a person supplies)',
        details,
      };
    }
    return null;
  }
  if ((ctx.to === 'on_hold' || ctx.to === 'reopen') && !hasText(ctx.transitionReason)) {
    const what =
      ctx.to === 'on_hold'
        ? 'why the work is paused, as `reason`'
        : 'what was not right, as `reason` — the next run starts from it';
    return {
      code: 'TRANSITION_REASON_REQUIRED',
      detail: `a move to ${quote(ctx.to)} carries ${what}`,
      details,
    };
  }
  if (ctx.to === 'dropped' && !hasText(ctx.transitionReason)) {
    return {
      code: 'VOID_REASON_REQUIRED',
      detail:
        'a move to `dropped` says why this is not work — a note, a duplicate, already done, obsolete — as `reason`; its `blocks` edges expire on it',
      details,
    };
  }
  return null;
}

/** in_progress, entered by a claim: a run or a lease holds the issue. */
async function holderGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const holder = await issueHolder(ctx.executor, ctx.issue);
  if (holder) return null;
  return {
    code: 'NO_HOLDER',
    detail: `\`in_progress\` says a run is working this issue, and nothing holds it: no live lease on its work state, and no job, run or fleet lease over it. Claim it first (a lease, or a run session), then move it — an issue nobody holds stays at ${quote(ctx.from)} where a master can take it.`,
    details: { from: ctx.from, to: ctx.to },
  };
}

async function planApprovalRequired(projectId: string): Promise<boolean> {
  const held = await readProjectDocument(projectId);
  return held?.document.plan?.approval.required === true;
}

/** approved, the plan checkpoint: a plan and criteria, and a person where the project says so. */
async function planGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const rows = (await ctx.executor.execute(sqlPlanRow(ctx.issue.id))) as unknown as Array<{
    plan: string | null;
    acceptance_criteria: string | null;
  }>;
  const row = rows[0];
  const missing = [
    isBlankPlan(row?.plan) ? 'plan' : null,
    isBlankPlan(row?.acceptance_criteria) ? 'acceptanceCriteria' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    return {
      code: 'PLAN_REQUIRED',
      detail: `\`approved\` is the plan checkpoint the next run builds from, and this issue has no ${missing.map(quote).join(' and ')} written. Write ${missing.length === 1 ? 'it' : 'them'} on the issue, then move it.`,
      details: { from: ctx.from, to: ctx.to, missing },
    };
  }
  if (ctx.agency !== 'human' && (await planApprovalRequired(ctx.issue.projectId))) {
    return {
      code: 'PLAN_REQUIRED',
      detail:
        'this project requires a person to approve a plan (project document `plan.approval.required`), so the move to `approved` is a person\'s to make. Ask for it: park at `needs_info` with `waitingKind: "needs_decision"` naming the plan, and the person who approves moves it once it is back.',
      details: { from: ctx.from, to: ctx.to, requires: 'human', rule: 'plan.approval.required' },
    };
  }
  return null;
}

/** awaiting_release: every criterion's latest verdict passes, and says what it held in. */
async function verdictGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const found = await unpassedCriteria(ctx.executor, ctx.issue.id);
  if (found.kind === 'no-criteria') {
    return {
      code: 'NO_WORK_EVIDENCE',
      detail:
        '`awaiting_release` says every criterion holds a passing verdict, and this issue has no numbered acceptance criteria for a verdict to hold on. Write the criteria and record a verdict on each, then move it.',
      details: { from: ctx.from, to: ctx.to, criteria: [] },
    };
  }
  if (found.unpassed.length > 0) {
    const named = found.unpassed
      .map((u) => `${u.criterion} (${u.verdict === null ? 'no verdict' : `\`${u.verdict}\``})`)
      .join(', ');
    return {
      code: 'NO_WORK_EVIDENCE',
      detail: `\`awaiting_release\` says every criterion holds a passing verdict, and criteria ${named} do not. A \`skipped\` or \`fail\` verdict never passes. Record a passing verdict on each, then move it.`,
      details: { from: ctx.from, to: ctx.to, unpassed: found.unpassed },
    };
  }
  if (found.unidentified.length > 0) {
    return {
      code: 'VERDICT_IDENTITY_REQUIRED',
      detail: `a passing verdict says what it held in — a full commit (\`source:\`), a runtime (\`runtime:\`) or a design revision (\`design: <flow> rev <n>\`) — and the latest verdict on criteria ${found.unidentified.join(', ')} names none. Record each again with its identity, then move it.`,
      details: { from: ctx.from, to: ctx.to, unidentified: found.unidentified },
    };
  }
  return null;
}

/**
 * A park returning to the status it left is the park's own edge, not an entry: the status was
 * earned when it was first entered, so its guard is not asked again. A park with no recorded left
 * status (`leftStatus` null) going anywhere is an entry like any other, and is guarded.
 */
function isParkReturn(ctx: GuardContext): boolean {
  return PARK_STATUSES.includes(ctx.from) && (ctx.leftStatus ?? null) === ctx.to;
}

/** The guards that read the row, asked inside the transition's transaction. */
export async function guardFault(ctx: GuardContext): Promise<GuardFault | null> {
  if (isParkReturn(ctx)) return null;
  switch (ctx.to) {
    case 'in_progress':
      return holderGuard(ctx);
    case 'approved':
      return planGuard(ctx);
    case 'awaiting_release':
      return verdictGuard(ctx);
    default:
      return null;
  }
}

function sqlPlanRow(issueId: string) {
  return sql`SELECT plan, acceptance_criteria FROM issues WHERE id = ${issueId}`;
}
