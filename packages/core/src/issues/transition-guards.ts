/**
 * One guard per move of workflow `issue-lifecycle` (approved revision 3), each refusing by name.
 * `apply-transition.ts` asks `edgeFault` before anything is written and `guardFault` inside the
 * transition's own transaction, so a guard reads the row the move will change.
 *
 *   into               condition                                                code
 *   any (edge)         the move is an edge of the lifecycle                      ILLEGAL_TRANSITION
 *   in_progress        a run or lease holds it; nothing admissible holds out     NO_HOLDER, ISSUE_BLOCKED, WORKFLOW_DESIGN_NOT_APPROVED, CONTRACT_WAIT_UNSETTLED
 *   approved           plan and criteria written; a person made the move where   PLAN_REQUIRED
 *                      the project document sets `plan.approval.required`
 *   awaiting_release   every criterion's latest verdict passes, with an          NO_WORK_EVIDENCE,
 *                      admissible identity, recorded after the latest reopen     VERDICT_IDENTITY_REQUIRED, VERDICT_PREDATES_REOPEN, VERDICT_IDENTITY_NOT_ADMISSIBLE, VERDICT_DRAFT_SUPERSEDED, VERDICT_UNCORROBORATED
 *   closed             shipped; from in_progress, as awaiting_release           CLOSE_REQUIRES_SHIPPED + the codes above
 *
 *   needs_info         a question (the reason) and its kind                      TRANSITION_REASON_REQUIRED,
 *                                                                                WAITING_KIND_REQUIRED
 *   on_hold, reopen    a reason                                                  TRANSITION_REASON_REQUIRED
 *   dropped            a reason                                                  VOID_REASON_REQUIRED
 */

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { approvalRefusalFor } from '../lib/approval.js';
import {
  canTransition,
  PARK_STATUSES,
  parkExitTargets,
  transitions,
} from '../pipeline/state-machine.js';
import { readProjectDocument } from '../project-config/service.js';
import type { ActorAgency } from './actor-agency.js';
import { IssueBlockedError, refuseHeldTake } from './blocked-by.js';
import type { DraftReader } from './criteria/storefront-draft.js';
import { isDispatchGateError } from './dispatch-gates.js';
import { type CriteriaEvidence, type SourceType, unpassedCriteria } from './release-evidence.js';
import { isBlankPlan } from './transition-evidence.js';
import { issueHolder } from './work-state.js';

export type GuardCode =
  | 'ILLEGAL_TRANSITION'
  | 'NO_HOLDER'
  | 'ISSUE_BLOCKED'
  | 'WORKFLOW_DESIGN_NOT_APPROVED'
  | 'CONTRACT_WAIT_UNSETTLED'
  | 'PLAN_REQUIRED'
  | 'APPROVE_PERMISSION_REQUIRED'
  | 'NO_WORK_EVIDENCE'
  | 'VERDICT_IDENTITY_REQUIRED'
  | 'VERDICT_PREDATES_REOPEN'
  | 'VERDICT_IDENTITY_NOT_ADMISSIBLE'
  | 'VERDICT_UNCORROBORATED'
  | 'VERDICT_DRAFT_SUPERSEDED'
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
  /** The account the move is made as: the user, or the owner of the device making it. */
  actorUserId: string;
  transitionReason?: string | undefined;
  waitingKind?: WaitingKind | undefined;
  executor: Pick<Tx, 'select' | 'execute'>;
  readDraft?: DraftReader | undefined;
}

const hasText = (s: string | undefined) => Boolean(s?.trim());

/** Reasons and kinds: the guards that read only the request. Asked before the write begins. */
export function reasonFault(
  ctx: Omit<GuardContext, 'executor' | 'issue' | 'leftStatus' | 'actorUserId'>,
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

// cm:why a person's move is refused as an agent's: issue-lifecycle rev 3 puts the condition on the edge, not the actor (ISS-104 decision)
async function heldTakeGuard(ctx: GuardContext): Promise<GuardFault | null> {
  try {
    await refuseHeldTake(ctx.executor, ctx.issue.id, 'a move to `in_progress`');
    return null;
  } catch (err) {
    if (err instanceof IssueBlockedError) {
      return {
        code: err.code,
        detail: err.message.replace(/^ISSUE_BLOCKED: /, ''),
        details: { from: ctx.from, to: ctx.to, blocked: err.blocked },
      };
    }
    if (isDispatchGateError(err)) {
      return {
        code: err.code,
        detail: err.message.replace(`${err.code}: `, ''),
        details: { from: ctx.from, to: ctx.to, blocked: err.blocked },
      };
    }
    throw err;
  }
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

/** approved, the plan checkpoint: a plan and criteria, and plans.approve where the project says so. */
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
  if (await planApprovalRequired(ctx.issue.projectId)) {
    const denied = await approvalRefusalFor(
      { userId: ctx.actorUserId },
      ctx.issue.projectId,
      'plans',
      'moving an issue to `approved` (project document `plan.approval.required`)',
    );
    if (denied) {
      return {
        code: denied.code,
        detail: `${denied.detail} Ask for it: park at \`needs_info\` with \`waitingKind: "needs_decision"\` naming the plan, and a holder of ${denied.permission} moves it once it is back.`,
        details: {
          from: ctx.from,
          to: ctx.to,
          permission: denied.permission,
          resource: denied.resource,
          rule: 'plan.approval.required',
        },
      };
    }
  }
  return null;
}

/**
 * awaiting_release, and in_progress → closed: every criterion's latest verdict passes, says what it
 * held in, and was recorded after the issue's latest reopen.
 */
async function verdictGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const source = (await readProjectDocument(ctx.issue.projectId))?.document.source.type ?? null;
  const found = await unpassedCriteria(ctx.executor, ctx.issue, source, ctx.readDraft);
  const into = quote(ctx.to);
  if (found.kind === 'no-criteria') {
    return {
      code: 'NO_WORK_EVIDENCE',
      detail: `${into} says every criterion holds a passing verdict, and this issue has no criteria for a verdict to hold on. Write them (\`PUT /api/issues/:id/criteria\`, or numbered \`acceptanceCriteria\`) and record a verdict on each (\`POST /api/issues/:id/verdicts\`), then move it.`,
      details: { from: ctx.from, to: ctx.to, criteria: [] },
    };
  }
  if (found.unpassed.length > 0) {
    const named = found.unpassed
      .map((u) => `${u.criterion} (${u.verdict === null ? 'no verdict' : `\`${u.verdict}\``})`)
      .join(', ');
    return {
      code: 'NO_WORK_EVIDENCE',
      detail: `${into} says every criterion holds a passing verdict, and criteria ${named} do not. A \`skipped\` or \`fail\` verdict never passes. Record a passing verdict on each, then move it.`,
      details: { from: ctx.from, to: ctx.to, unpassed: found.unpassed },
    };
  }
  if (found.predateReopen.length > 0) {
    const at = found.reopenedAt?.toISOString() ?? 'its reopen';
    return {
      code: 'VERDICT_PREDATES_REOPEN',
      detail: `this issue was reopened at ${at}, and the passing verdicts on criteria ${found.predateReopen.join(', ')} were recorded before that: a reopen says the work was not right, so evidence from before it is not current. Record a new verdict on each against the work done since the reopen, then move it.`,
      details: {
        from: ctx.from,
        to: ctx.to,
        reopenedAt: found.reopenedAt?.toISOString() ?? null,
        predateReopen: found.predateReopen,
      },
    };
  }
  if (found.unidentified.length > 0) {
    return {
      code: 'VERDICT_IDENTITY_REQUIRED',
      detail: `a passing verdict says what it held in — a whole commit sha, a runtime, a design revision (\`<flow> rev <n>\`) or a contract version (\`<ref>@<version>\`) — and the latest verdict on criteria ${found.unidentified.join(', ')} names none the gate accepts (a backfilled \`commit_unresolved\` abbreviation is not one). Record each again with its identity, then move it.`,
      details: { from: ctx.from, to: ctx.to, unidentified: found.unidentified },
    };
  }
  return storefrontDraftFault(ctx, found, source);
}

export function storefrontDraftFault(
  ctx: GuardContext,
  found: Extract<CriteriaEvidence, { kind: 'criteria' }>,
  source: SourceType,
): GuardFault | null {
  if (found.inadmissible.length > 0) {
    const held = source === null ? 'declares no project document' : `has source \`${source}\``;
    return {
      code: 'VERDICT_IDENTITY_NOT_ADMISSIBLE',
      detail: `the latest verdict on criteria ${found.inadmissible.join(', ')} names a storefront draft, and this project ${held}: a draft stands in for a landed commit only where the work lives on a storefront (\`source.type: "storefront"\`). Record each against the commit or runtime it was judged at, then move it.`,
      details: { from: ctx.from, to: ctx.to, source, inadmissible: found.inadmissible },
    };
  }
  if (found.superseded.length > 0) {
    const named = found.superseded.map((u) => `${u.criterion} (${u.note})`).join('; ');
    return {
      code: 'VERDICT_DRAFT_SUPERSEDED',
      detail: `a storefront draft counts only while it is the draft the storefront source holds, and the latest verdict on criteria ${named}. Judge each again at the draft \`forge_storefront_target\` reports now, record it naming that draft version, then move it.`,
      details: { from: ctx.from, to: ctx.to, superseded: found.superseded },
    };
  }
  if (found.uncorroborated.length > 0) {
    const named = found.uncorroborated.map((u) => `${u.criterion} (${u.note})`).join('; ');
    return {
      code: 'VERDICT_UNCORROBORATED',
      detail: `a storefront draft counts once the storefront source reads it back as the draft it holds, and the latest verdict on criteria ${named} was not. Record each again naming the draft version \`forge_storefront_target\` reports now, then move it.`,
      details: { from: ctx.from, to: ctx.to, uncorroborated: found.uncorroborated },
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
      return (await heldTakeGuard(ctx)) ?? holderGuard(ctx);
    case 'approved':
      return planGuard(ctx);
    case 'awaiting_release':
      return verdictGuard(ctx);
    // cm:guard ISS-96 — a close from in_progress claims the proof awaiting_release asks for, on every
    // issue whether or not it was ever reopened; an issue that is not work is dropped, never closed
    case 'closed':
      return ctx.from === 'in_progress' ? verdictGuard(ctx) : null;
    default:
      return null;
  }
}

function sqlPlanRow(issueId: string) {
  return sql`SELECT plan, acceptance_criteria FROM issues WHERE id = ${issueId}`;
}
