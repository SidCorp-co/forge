// The two refusals a move meets before any guard runs: an edge the machine does not draw, and a
// reason the move owes and did not give.

import { ISSUE_MACHINE, PARK_STATUSES } from '@forge/contracts/issue-machine';
import { edgeBetween } from '@forge/contracts/state-machine';
import type { IssueStatus } from '../db/schema.js';
import { type GuardContext, type GuardFault } from './transition-guards.js';

export const quote = (s: string) => `\`${s}\``;

const list = (statuses: readonly string[]) => statuses.map(quote).join(', ');

/** The moves out of `from` a person may name: a park's return (to the status it left, or any
 *  parkable one where none is recorded), then the machine's other lifecycle exits. */
function allowedExits(from: IssueStatus, leftStatus: IssueStatus | null): IssueStatus[] {
  const out: IssueStatus[] = [];
  for (const e of ISSUE_MACHINE.edges) {
    if (e.from !== from || e.recovery || out.includes(e.to)) continue;
    if (e.guards.includes('left_status') && leftStatus !== null && e.to !== leftStatus) continue;
    out.push(e.to);
  }
  return out;
}

/** The edge check: whether `from → to` is a move of the issue machine at all. */
export function edgeFault(args: {
  from: IssueStatus;
  to: IssueStatus;
  leftStatus: IssueStatus | null;
}): GuardFault | null {
  const { from, to, leftStatus } = args;
  const allowed = allowedExits(from, leftStatus);
  if (allowed.includes(to)) return null;
  const details = { from, to, allowed, leftStatus };
  if (PARK_STATUSES.includes(from) && leftStatus !== null && edgeBetween(ISSUE_MACHINE, from, to)) {
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

const hasText = (s: string | undefined) => Boolean(s?.trim());

/** Reasons and kinds: the guards that read only the request. Asked before the write begins. */
export function reasonFault(
  ctx: Omit<GuardContext, 'executor' | 'issue' | 'leftStatus' | 'actorUserId' | 'facts'>,
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
