/**
 * ISS-902 (FB-480): a confirm wait is a reason and a date to come within the limit, on a shipped item
 * an agent reported; it holds until its date passes or its event happens, and then reads as ended.
 *
 * @direct-test-of packages/core/src/feedback/confirm-wait-facts.ts
 */

import { describe, expect, it } from 'vitest';
import { confirmWaitEnded, confirmWaitOf, confirmWaitRefusal } from './confirm-wait-facts.js';

const now = new Date('2026-11-02T10:00:00.000Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const owed = { key: 'FB-470', phase: 'resolved' as const, agentReported: true };
const wait = (o: Partial<{ until: Date; reason: string | undefined }> = {}) => ({
  until: days(3),
  on: 'room_message' as const,
  reason: 'needs the owner’s next message in the room',
  ...o,
});

describe('confirmWaitRefusal', () => {
  it('takes a reason and a date to come on a shipped agent-reported item', () => {
    expect(confirmWaitRefusal(owed, wait(), now)).toBeNull();
    expect(confirmWaitRefusal(owed, wait({ until: days(30) }), now)).toBeNull();
  });

  it('refuses a wait with no reason by name, saying where and the shape that is valid', () => {
    for (const reason of [undefined, '', '   ']) {
      const r = confirmWaitRefusal(owed, wait({ reason }), now);
      expect(r?.code).toBe('FEEDBACK_CONFIRM_WAIT_REASON_REQUIRED');
      expect(r?.path).toBe('/reason');
      expect(r?.detail).toContain('FB-470');
      expect(r?.detail).toContain('{ until: ISO 8601 date-time within 30 days');
      expect(r?.detail).toContain('reason }');
    }
  });

  it('refuses an item that owes no agent’s confirm: unshipped, or reported by a person', () => {
    const planned = confirmWaitRefusal({ ...owed, phase: 'planned' }, wait(), now);
    expect(planned).toMatchObject({ code: 'FEEDBACK_CONFIRM_WAIT_NOT_OWED', path: '/feedback' });
    expect(planned?.detail).toContain('reads planned');
    const person = confirmWaitRefusal({ ...owed, agentReported: false }, wait(), now);
    expect(person?.code).toBe('FEEDBACK_CONFIRM_WAIT_NOT_OWED');
    expect(person?.detail).toContain('a person reported it');
  });

  it('refuses a date not to come, and one past the limit, at /until', () => {
    expect(confirmWaitRefusal(owed, wait({ until: now }), now)?.code).toBe(
      'FEEDBACK_CONFIRM_WAIT_PAST',
    );
    expect(confirmWaitRefusal(owed, wait({ until: new Date('nope') }), now)?.path).toBe('/until');
    const far = confirmWaitRefusal(owed, wait({ until: days(30.01) }), now);
    expect(far).toMatchObject({ code: 'FEEDBACK_CONFIRM_WAIT_TOO_FAR', path: '/until' });
  });
});

describe('confirmWaitOf and confirmWaitEnded', () => {
  const set = {
    confirmWaitUntil: days(3),
    confirmWaitOn: 'room_message' as const,
    confirmWaitReason: 'needs the owner’s next message',
    confirmWaitSetAt: now,
    confirmWaitSetBy: 'u1',
    confirmWaitMetAt: null as Date | null,
  };
  const none = {
    ...set,
    confirmWaitUntil: null,
    confirmWaitOn: null,
    confirmWaitReason: null,
    confirmWaitSetAt: null,
    confirmWaitSetBy: null,
  };

  it('reads a wait that holds, with its reason unless withheld', () => {
    expect(confirmWaitOf(set, now)).toEqual({
      until: days(3).toISOString(),
      on: 'room_message',
      reason: 'needs the owner’s next message',
      setAt: now.toISOString(),
      setBy: 'u1',
    });
    expect(confirmWaitOf(set, now, true)?.reason).toBeNull();
    expect(confirmWaitEnded(set, now)).toBeNull();
  });

  it('reads none once its date passed, and says it lapsed', () => {
    expect(confirmWaitOf(set, days(3))).toBeNull();
    expect(confirmWaitEnded(set, days(3))).toBe('lapsed');
  });

  it('reads none once its event happened, and says it was met', () => {
    const met = { ...set, confirmWaitMetAt: days(1) };
    expect(confirmWaitOf(met, days(1))).toBeNull();
    expect(confirmWaitEnded(met, days(1))).toBe('met');
  });

  it('reads nothing on an item no wait was set on', () => {
    expect(confirmWaitOf(none, now)).toBeNull();
    expect(confirmWaitEnded(none, now)).toBeNull();
  });
});
