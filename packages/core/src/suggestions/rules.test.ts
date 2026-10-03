import { describe, expect, it } from 'vitest';
import {
  baseStaleRefusal,
  decidedRefusal,
  deciderRefusal,
  duplicateRefusal,
  fingerprintOf,
  MAX_OPEN_PER_TARGET,
  payloadRefusal,
  queueFullRefusal,
  rejectReasonRefusal,
  withdrawRefusal,
} from './rules.js';

const person = {
  userId: 'u1',
  agency: 'human' as const,
  role: 'member' as const,
  producerId: 'p1',
};

describe('suggestion-lifecycle guards', () => {
  it('start → proposed: a payload that does not parse for its kind is SUGGESTION_PAYLOAD_INVALID', () => {
    expect(
      payloadRefusal('revision_diff', 'requirement', { reason: 'r', criteria: [] }),
    ).toBeNull();
    expect(payloadRefusal('revision_diff', 'requirement', { criteria: [] })?.code).toBe(
      'SUGGESTION_PAYLOAD_INVALID',
    );
  });

  it('start → proposed: a kind on a target it does not take is SUGGESTION_TARGET_INVALID', () => {
    expect(payloadRefusal('revision_diff', 'issue', { reason: 'r', criteria: [] })?.code).toBe(
      'SUGGESTION_TARGET_INVALID',
    );
  });

  it('start → proposed and proposed → accepted: a base that is not the head is SUGGESTION_BASE_STALE naming both', () => {
    expect(baseStaleRefusal(3, 3)).toBeNull();
    const stale = baseStaleRefusal(3, 4);
    expect(stale?.code).toBe('SUGGESTION_BASE_STALE');
    expect(stale?.detail).toContain('revision 3');
    expect(stale?.detail).toContain('revision 4');
  });

  it('start → proposed: an open twin is SUGGESTION_DUPLICATE, and key order does not make a new one', () => {
    expect(fingerprintOf('duplicate', { a: 1, b: 2 })).toBe(
      fingerprintOf('duplicate', { b: 2, a: 1 }),
    );
    expect(duplicateRefusal(null)).toBeNull();
    expect(duplicateRefusal('s1')?.code).toBe('SUGGESTION_DUPLICATE');
  });

  it('proposed: the 6th open on one target is SUGGESTION_QUEUE_FULL', () => {
    expect(queueFullRefusal(MAX_OPEN_PER_TARGET - 1)).toBeNull();
    expect(queueFullRefusal(MAX_OPEN_PER_TARGET)?.code).toBe('SUGGESTION_QUEUE_FULL');
  });

  it('proposed → accepted: an agent, a non-member or the producer is SUGGESTION_ACCEPT_FORBIDDEN', () => {
    expect(deciderRefusal(person, 'accept')).toBeNull();
    expect(deciderRefusal({ ...person, agency: 'agent' }, 'accept')?.code).toBe(
      'SUGGESTION_ACCEPT_FORBIDDEN',
    );
    expect(deciderRefusal({ ...person, role: 'viewer' }, 'accept')?.code).toBe(
      'SUGGESTION_ACCEPT_FORBIDDEN',
    );
    expect(deciderRefusal({ ...person, producerId: 'u1' }, 'accept')?.code).toBe(
      'SUGGESTION_ACCEPT_FORBIDDEN',
    );
  });

  it('proposed → rejected: a rejection without a reason is SUGGESTION_REJECT_REASON_REQUIRED', () => {
    expect(rejectReasonRefusal('not what the BA meant')).toBeNull();
    expect(rejectReasonRefusal('  ')?.code).toBe('SUGGESTION_REJECT_REASON_REQUIRED');
  });

  it('after a final state: accept, reject or withdraw is SUGGESTION_DECIDED naming the status', () => {
    expect(decidedRefusal('proposed')).toBeNull();
    const decided = decidedRefusal('stale');
    expect(decided?.code).toBe('SUGGESTION_DECIDED');
    expect(decided?.detail).toContain('stale');
  });

  it('proposed → withdrawn: only the producer withdraws (SUGGESTION_WITHDRAW_FORBIDDEN)', () => {
    expect(withdrawRefusal('p1', 'p1')).toBeNull();
    expect(withdrawRefusal('u1', 'p1')?.code).toBe('SUGGESTION_WITHDRAW_FORBIDDEN');
  });
});
