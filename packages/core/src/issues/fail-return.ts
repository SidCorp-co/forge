/**
 * The `fail_routed` guard's reading (ISS-760, issue-lifecycle revision 23): an issue a
 * requirement-level fail reopened goes back to the status it was reopened from once that fail is
 * routed past it. Read before the move takes its lock (`transition-guards.ts:readIssueMoveFacts`),
 * since the routing reads the requirement's standing on connections of its own.
 *
 * Which reopen: the issue's latest move into `reopen` from `awaiting_release` or `closed` — a
 * hand-back from `in_progress` and a park's return are not one. Its cause is the requirement verdict
 * its reason cites as the fail consumer words it (`fail-wording.ts`), checked to be a fail at a
 * requirement of the issue's project: orbit ISS-16's reopen predates any other record of it.
 *
 *   refused                                                          code
 *   no such reopen, or its reason cites no requirement fail          REOPEN_NOT_BY_REQUIREMENT_FAIL
 *   the move names the other landed status                           ILLEGAL_TRANSITION
 *   one of its own criteria tracing the BC does not count as a pass  REOPEN_CRITERIA_NOT_PASSING
 *   they pass, and no other issue owns what the BC lacks             REOPEN_FAIL_UNOWNED
 */

import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { portSlot } from '../lib/port-slot.js';
import { failedWhat, requirementFailCited, staysNote } from './fail-wording.js';
import { quote } from './transition-faults.js';
import type { GuardFault } from './transition-guards.js';

/** What the way back asks the requirements context: the fail, and the status the issue would be back at. */
export interface FailReturnAsk {
  projectId: string;
  issueId: string;
  verdictId: string;
  status: IssueStatus;
}

/**
 * What the way back from a requirement-level fail's reopen reads of that fail (ISS-760): none where
 * the verdict is not a fail at a requirement of the issue's project, else the BC it judged, the
 * fail's own reason, what `routeFail` makes of the issue at the status it returns to, and each of its
 * own criteria tracing the BC that does not count as a pass.
 */
export type RequirementFailReturn =
  | { kind: 'none' }
  | {
      kind: 'read';
      bc: string;
      reason: string | null;
      /** Every one of its own criteria tracing the BC counts as a pass, and it has one. */
      delivers: boolean;
      outcome: 'reopen' | 'building' | 'stays';
      why: string;
      notPassing: { criterion: number; verdict: string | null; why: string | null }[];
    };

/**
 * How a requirement fail routes an issue were it back now, from the requirements context the issue
 * kernel may not import (`requirements/fail-return.ts`); the composition root provides it at boot.
 */
const slot = portSlot<{
  requirementFailReturn: (args: FailReturnAsk) => Promise<RequirementFailReturn>;
}>('issues fail-return', 'provideFailReturnPort');
export const provideFailReturnPort = slot.provide;
const requirementFailReturn = slot.port('requirementFailReturn');

/** What the guard reads of the reopen it would undo. */
export interface FailReturnFacts {
  /** The status the latest reopen from a landed status came from; null where there is none. */
  reopenedFrom: IssueStatus | null;
  /** That reopen's reason, as the move recorded it. */
  reason: string | null;
  /** The requirement verdict that reason cites; null where it cites none. */
  verdictId: string | null;
  /** How that fail routes the issue were it back now; null where nothing was cited. */
  routed: RequirementFailReturn | null;
}

export async function readFailReturn(
  executor: Pick<Tx, 'execute'>,
  issue: { id: string; projectId: string },
): Promise<FailReturnFacts> {
  const [reopen] = (await executor.execute(sql`
    SELECT from_status, reason FROM kernel_transitions
     WHERE entity = 'issue' AND entity_id = ${issue.id}::uuid AND to_status = 'reopen'
       AND from_status IN ('awaiting_release', 'closed')
     ORDER BY created_at DESC, id DESC LIMIT 1
  `)) as unknown as Array<{ from_status: IssueStatus; reason: string | null }>;
  if (!reopen) return { reopenedFrom: null, reason: null, verdictId: null, routed: null };
  const verdictId = requirementFailCited(reopen.reason);
  const routed = verdictId
    ? await requirementFailReturn({
        projectId: issue.projectId,
        issueId: issue.id,
        verdictId,
        status: reopen.from_status,
      })
    : null;
  return { reopenedFrom: reopen.from_status, reason: reopen.reason, verdictId, routed };
}

/** Whether a move is the way back this guard judges: from `reopen` to a landed status. */
export const asksFailReturn = (from: IssueStatus, to: IssueStatus): boolean =>
  from === 'reopen' && ISSUE_RESOLVED_STATUSES.includes(to);

const excerpt = (reason: string | null) => {
  if (!reason?.trim()) return 'with no reason';
  const text = reason.trim();
  return `saying "${text.length > 160 ? `${text.slice(0, 157)}...` : text}"`;
};

/** The guard's fault, or null where the fail is routed past the issue and the move may go back. */
export function failReturnFault(
  facts: FailReturnFacts,
  move: { from: IssueStatus; to: IssueStatus },
): GuardFault | null {
  const details = { from: move.from, to: move.to, reopenedFrom: facts.reopenedFrom };
  const { routed } = facts;
  if (!facts.reopenedFrom || routed?.kind !== 'read') {
    const which = facts.reopenedFrom
      ? `its reopen from ${quote(facts.reopenedFrom)} was not a requirement-level fail's: it was made ${excerpt(facts.reason)}${facts.verdictId ? `, and verdict ${facts.verdictId} is no fail at a requirement of this project` : ''}`
      : 'nothing reopened it from `awaiting_release` or `closed`';
    return {
      code: 'REOPEN_NOT_BY_REQUIREMENT_FAIL',
      detail: `${quote('reopen')} → ${quote(move.to)} goes back only where a requirement-level fail reopened the issue and is routed past it now, and ${which}. Work it from \`reopen\`: claim it to \`in_progress\`.`,
      details: { ...details, verdictId: facts.verdictId },
    };
  }
  if (move.to !== facts.reopenedFrom) {
    return {
      code: 'ILLEGAL_TRANSITION',
      detail: `the requirement-level fail reopened this issue from ${quote(facts.reopenedFrom)}, and it goes back there, not to ${quote(move.to)}.`,
      details,
    };
  }
  const bcDetails = { ...details, verdictId: facts.verdictId, requirement: routed.bc };
  if (!routed.delivers) {
    const named =
      routed.notPassing.length === 0
        ? `none of its criteria counts on ${routed.bc}`
        : routed.notPassing
            .map(
              (c) =>
                `criterion ${c.criterion} (${c.verdict ?? 'no verdict'}${c.why ? `: ${c.why}` : ''})`,
            )
            .join(', ');
    return {
      code: 'REOPEN_CRITERIA_NOT_PASSING',
      detail: `${routed.bc} failed at its requirement, and this issue's own criteria tracing it do not all pass: ${named}. The fail is this issue's to correct: work it from \`reopen\`.`,
      details: { ...bcDetails, notPassing: routed.notPassing },
    };
  }
  if (routed.outcome !== 'stays') {
    return {
      code: 'REOPEN_FAIL_UNOWNED',
      detail: `${routed.bc} failed at its requirement, and though this issue's own criteria tracing it pass, no other issue owns what it lacks: ${routed.why}. It stays at \`reopen\` until another issue traces ${routed.bc}, or ${routed.bc} is judged again at its requirement.`,
      details: bcDetails,
    };
  }
  return null;
}

/** The note the way back posts on the issue: the one a fail that stays on it posts (ISS-756). */
export function failReturnNote(facts: FailReturnFacts, to: IssueStatus): string | null {
  const { routed } = facts;
  if (routed?.kind !== 'read' || !facts.verdictId) return null;
  const what = failedWhat({
    requirement: routed.bc,
    criterion: null,
    verdictId: facts.verdictId,
    reason: routed.reason,
  });
  return staysNote(what, to, routed.why);
}
