// The guards of the requirement's delivery moves (REQ-74 BC-8..10): into delivery, to delivered, to
// accepted (by its checklist, or by decision over it), and → dropped, as pure functions over what
// `acceptance.ts` read.

import { isDeliveringStatus } from '@forge/contracts/requirements';
import type { RequirementStatus } from '../db/schema-requirements.js';
import { deferredRefusal, type RequirementRefusal } from './rules.js';

/** What an accept reads of the delivery, in the accept's own transaction (`acceptance.ts:deliveryIn`). */
export interface DeliveryProof {
  /** Live linked issues not yet closed, by key. */
  unshipped: readonly string[];
  liveIssues: number;
  /** It has no live issue and rests on its shipped capability (`standing-shipped.ts:restsOnShipped`, ISS-588). */
  shipped: boolean;
  /** Current business criteria whose coverage is not passing, each with its verdict and the reason
   *  coverage gives for it (`RequirementCoverage.why`), null where it gives none. */
  unproven: readonly { code: string; verdict: string; why: string | null }[];
}

// workflow requirement-lifecycle edge delivered → accepted: the requirement stands agreed and the
// accept names its head (REQUIREMENT_REVISION_STALE). Whether it was delivered — every live issue
// shipped, every current BC passing on the running build, each verdict cited — is the acceptance
// checklist's (Requirement lifecycle r15 acceptance_check, `checklist-record.ts`), judged by the kernel
export function acceptRefusals(input: {
  status: RequirementStatus;
  named: number;
  head: number | null;
}): RequirementRefusal[] {
  const deferred = deferredRefusal(input.status, 'accepting its delivery', '/revision');
  if (deferred) return [deferred];
  if (input.status === 'accepted') {
    return [
      {
        code: 'REQUIREMENT_ALREADY_ACCEPTED',
        path: '/revision',
        detail: `the delivery at revision ${input.head ?? '?'} is already accepted; a correction comes in as feedback, and a new revision re-agrees it.`,
      },
    ];
  }
  if (!isDeliveringStatus(input.status)) {
    return [
      {
        code: 'REQUIREMENT_NOT_DELIVERED',
        path: '',
        detail: `the requirement is ${input.status}; only an agreed, in delivery or delivered requirement is accepted.`,
      },
    ];
  }
  if (input.named !== input.head) {
    return [
      {
        code: 'REQUIREMENT_REVISION_STALE',
        path: '/revision',
        detail: `the accept names revision ${input.named}, but the head is ${input.head === null ? 'none yet' : `revision ${input.head}`}; read the head and accept that delivery.`,
      },
    ];
  }
  return [];
}

// workflow requirement-lifecycle edge → dropped: from any status the machine lets leave for it (not
// accepted, not dropped), with a reason, and never while a live issue links to it
/**
 * A sign-off that writes a baseline records why (REQ-4 BC-4, ADR 0007): an agree or a re-pin with
 * no reason is refused by name, never stored with an empty one.
 */
export function signoffReasonRefusal(
  act: 'agree' | 'repin',
  reason: string | null | undefined,
): RequirementRefusal | null {
  if (reason?.trim()) return null;
  return {
    code: 'REQUIREMENT_SIGNOFF_REASON_REQUIRED',
    path: '/reason',
    detail: `${act === 'agree' ? 'an agree' : 'a re-pin'} records why it is signed and on whose authority: send { revision, reason } with reason a non-blank sentence.`,
  };
}

export function dropRefusals(input: {
  status: RequirementStatus;
  droppable: readonly RequirementStatus[];
  reason: string | null | undefined;
  liveIssues: readonly string[];
}): RequirementRefusal[] {
  const out: RequirementRefusal[] = [];
  if (!input.droppable.includes(input.status)) {
    out.push({
      code: 'REQUIREMENT_NOT_DROPPABLE',
      path: '',
      detail: `the requirement is ${input.status}; only a ${input.droppable.join(', ')} requirement is dropped.`,
    });
  }
  if (!input.reason?.trim()) {
    out.push({
      code: 'REQUIREMENT_DROP_REASON_REQUIRED',
      path: '/reason',
      detail:
        'a dropped requirement says why it is not going to be built, so nobody re-proposes it.',
    });
  }
  if (input.liveIssues.length) {
    out.push({
      code: 'REQUIREMENT_HAS_LIVE_ISSUES',
      path: '',
      detail: `live issues still link to it: ${input.liveIssues.join(', ')}; drop or unlink each before the requirement is dropped.`,
    });
  }
  return out;
}

/** A requirement is dropped as a duplicate only of another live requirement, never of itself or of one already dropped. */
export function duplicateTargetRefusal(
  duplicateId: string,
  original: { id: string; reqSeq: number; status: string } | null,
  named: string,
): RequirementRefusal | null {
  if (!original) {
    return {
      code: 'REQUIREMENT_DUPLICATE_TARGET_INVALID',
      path: '/payload/duplicateOf',
      detail: `${named} is not a requirement of this project, so nothing can be named as the one this repeats.`,
    };
  }
  if (original.id === duplicateId) {
    return {
      code: 'REQUIREMENT_DUPLICATE_TARGET_INVALID',
      path: '/payload/duplicateOf',
      detail: `REQ-${original.reqSeq} cannot be a duplicate of itself; name the requirement it repeats.`,
    };
  }
  if (original.status === 'dropped') {
    return {
      code: 'REQUIREMENT_DUPLICATE_TARGET_INVALID',
      path: '/payload/duplicateOf',
      detail: `REQ-${original.reqSeq} is dropped, so nothing would carry the work; name a live requirement it repeats, or drop this one on its own.`,
    };
  }
  return null;
}

/**
 * An accept by decision moves over the acceptance checklist's blocking items, so it says why, and it
 * never moves over unfinished work: a linked issue neither closed nor dropped is relinked or finished
 * first, each named.
 */
export function decisionRefusals(input: {
  reason: string | null | undefined;
  unfinished: readonly string[];
}): RequirementRefusal[] {
  const out: RequirementRefusal[] = [];
  if (!input.reason?.trim()) {
    out.push({
      code: 'REQUIREMENT_DECISION_REASON_REQUIRED',
      path: '/reason',
      detail:
        'an accept by decision waives the acceptance checklist, so it says why: send a non-blank reason.',
    });
  }
  if (input.unfinished.length) {
    out.push({
      code: 'REQUIREMENT_HAS_UNFINISHED_ISSUES',
      path: '',
      detail: `linked issues are not finished: ${input.unfinished.join(', ')}; finish, drop or relink each before it is accepted by decision.`,
    });
  }
  return out;
}

/** agreed → in_delivery (REQ-74 BC-9): a live issue is linked to deliver it. */
export function liveIssueRefusal(liveIssues: number): RequirementRefusal | null {
  if (liveIssues > 0) return null;
  return {
    code: 'REQUIREMENT_NO_LIVE_ISSUE',
    path: '',
    detail:
      'no live issue is linked to it, so nothing delivers it; link an issue before it moves into delivery.',
  };
}

/** in_delivery → delivered (REQ-74 BC-10): every live criterion has a pass on the running build, each one without named. */
export function provenRefusal(
  coverage: readonly { code: string; verdict: string; why: string | null }[],
): RequirementRefusal | null {
  const unproven = coverage.filter((c) => c.verdict !== 'passing');
  if (coverage.length > 0 && unproven.length === 0) return null;
  return {
    code: 'REQUIREMENT_CRITERIA_UNPROVEN',
    path: '',
    detail:
      coverage.length === 0
        ? 'it has no live criterion, so nothing can pass on the running build; agree a revision with criteria first.'
        : `not every live criterion has a pass on the running build: ${unproven
            .map((c) => `${c.code} (${c.verdict.replace('_', ' ')}${c.why ? `: ${c.why}` : ''})`)
            .join('; ')}.`,
  };
}
