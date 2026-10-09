// The guards of workflow requirement-lifecycle r4's two closing edges, delivered → accepted and
// → dropped, as pure functions over what `acceptance.ts` read.

import type { RequirementStatus } from '../db/schema-requirements.js';
import { deferredRefusal, type RequirementRefusal } from './rules.js';

/** What an accept reads of the delivery, in the accept's own transaction (`acceptance.ts:deliveryIn`). */
export interface DeliveryProof {
  /** Live linked issues not yet closed, by key. */
  unshipped: readonly string[];
  liveIssues: number;
  /** Current business criteria whose coverage is not passing, each with its verdict and the reason
   *  coverage gives for it (`RequirementCoverage.why`), null where it gives none. */
  unproven: readonly { code: string; verdict: string; why: string | null }[];
}

// workflow requirement-lifecycle edge delivered → accepted: a holder of requirements.approve names
// the head (REQUIREMENT_REVISION_STALE); the phase reads delivered in the same transaction, every
// live linked issue closed and at least one (REQUIREMENT_NOT_DELIVERED); every current BC proven
// (REQUIREMENT_CRITERIA_UNPROVEN). The phase is the conjunction of the last two, so each is named
// for its own cause
export function acceptRefusals(input: {
  status: RequirementStatus;
  named: number;
  head: number | null;
  proof: DeliveryProof;
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
  if (input.status !== 'agreed') {
    return [
      {
        code: 'REQUIREMENT_NOT_DELIVERED',
        path: '',
        detail: `the requirement is ${input.status}; only an agreed requirement whose linked issues all shipped is accepted.`,
      },
    ];
  }
  const out: RequirementRefusal[] = [];
  if (input.named !== input.head) {
    out.push({
      code: 'REQUIREMENT_REVISION_STALE',
      path: '/revision',
      detail: `the accept names revision ${input.named}, but the head is ${input.head === null ? 'none yet' : `revision ${input.head}`}; read the head and accept that delivery.`,
    });
  }
  const { proof } = input;
  if (proof.liveIssues === 0 || proof.unshipped.length > 0) {
    out.push({
      code: 'REQUIREMENT_NOT_DELIVERED',
      path: '',
      detail:
        proof.liveIssues === 0
          ? 'no live issue links to the requirement, so nothing was delivered; break it down first.'
          : `linked issues are not closed: ${proof.unshipped.join(', ')}; the delivery is accepted once every live linked issue shipped.`,
    });
  }
  if (proof.unproven.length > 0) {
    out.push({
      code: 'REQUIREMENT_CRITERIA_UNPROVEN',
      path: '',
      detail: `every current business criterion is proven by a passing verdict before the accept; not proven: ${proof.unproven
        .map((c) => `${c.code} (${c.verdict.replace('_', ' ')}${c.why ? `: ${c.why}` : ''})`)
        .join(', ')}.`,
    });
  }
  return out;
}

// workflow requirement-lifecycle edge → dropped: from any status the machine lets leave for it (not
// accepted, not dropped), with a reason, and never while a live issue links to it
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
