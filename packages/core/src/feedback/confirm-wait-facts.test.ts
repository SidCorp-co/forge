/**
 * ISS-902 (FB-480): a confirm wait is a reason and a date to come within the limit, on a shipped item
 * an agent reported; it holds until its date passes or its event happens, and then reads as ended.
 *
 * ISS-1038: a room-message wait names its group and thread, and keeps the message that met it.
 *
 * @direct-test-of packages/core/src/feedback/confirm-wait-facts.ts
 */

import { describe, expect, it } from 'vitest';
import {
  confirmWaitEnded,
  confirmWaitMetOf,
  confirmWaitOf,
  confirmWaitRefusal,
} from './confirm-wait-facts.js';

const now = new Date('2026-11-02T10:00:00.000Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const owed = { key: 'FB-470', phase: 'resolved' as const, agentReported: true };
const wait = (
  o: Partial<{
    until: Date;
    reason: string | undefined;
    on: 'room_message' | undefined;
    rid: string;
    thread: string;
  }> = {},
) => ({
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
      expect(r?.detail).toContain('reason, rid? and thread?');
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

// ISS-1038: a room-message wait names the group and thread its message is awaited in, both or neither
describe('the room a wait names', () => {
  it('takes both with on room_message, or neither', () => {
    expect(confirmWaitRefusal(owed, wait({ rid: 'GRP1', thread: 't-4' }), now)).toBeNull();
    expect(confirmWaitRefusal(owed, wait(), now)).toBeNull();
  });

  it('refuses one without the other, or either without on room_message, by name', () => {
    expect(confirmWaitRefusal(owed, wait({ rid: 'GRP1' }), now)).toMatchObject({
      code: 'FEEDBACK_CONFIRM_WAIT_ROOM',
      path: '/thread',
    });
    expect(confirmWaitRefusal(owed, wait({ thread: 't-4' }), now)).toMatchObject({
      code: 'FEEDBACK_CONFIRM_WAIT_ROOM',
      path: '/rid',
    });
    expect(
      confirmWaitRefusal(owed, wait({ on: undefined, rid: 'GRP1', thread: 't-4' }), now),
    ).toMatchObject({ code: 'FEEDBACK_CONFIRM_WAIT_ROOM', path: '/on' });
  });

  it('shows the message that met a wait, its words withheld where the item’s are', () => {
    const metBy = {
      message: 'm-77',
      rid: 'GRP1',
      thread: 't-4',
      author: 'tuyen',
      at: now.toISOString(),
      text: 'works now',
    };
    expect(confirmWaitMetOf({ confirmWaitMetAt: now, confirmWaitMetBy: metBy }, false)).toEqual(
      metBy,
    );
    expect(confirmWaitMetOf({ confirmWaitMetAt: now, confirmWaitMetBy: metBy }, true)?.text).toBe(
      null,
    );
    expect(confirmWaitMetOf({ confirmWaitMetAt: null, confirmWaitMetBy: null }, false)).toBeNull();
  });
});

describe('confirmWaitOf and confirmWaitEnded', () => {
  const set = {
    confirmWaitUntil: days(3),
    confirmWaitOn: 'room_message' as const,
    confirmWaitReason: 'needs the owner’s next message',
    confirmWaitSetAt: now,
    confirmWaitSetBy: 'u1',
    confirmWaitRid: 'GRP1' as string | null,
    confirmWaitThread: 't-4' as string | null,
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
    expect(confirmWaitOf(set, now, false, false)).toEqual({
      until: days(3).toISOString(),
      on: 'room_message',
      room: { rid: 'GRP1', thread: 't-4' },
      reason: 'needs the owner’s next message',
      setAt: now.toISOString(),
      setBy: 'u1',
    });
    expect(confirmWaitOf(set, now, true, false)?.reason).toBeNull();
    expect(confirmWaitEnded(set, now, false)).toBeNull();
  });

  it('reads none once its date passed, and says it lapsed', () => {
    expect(confirmWaitOf(set, days(3), false, false)).toBeNull();
    expect(confirmWaitEnded(set, days(3), false)).toBe('lapsed');
  });

  it('reads none once its event happened, and says it was met', () => {
    const met = { ...set, confirmWaitMetAt: days(1) };
    expect(confirmWaitOf(met, days(1), false, false)).toBeNull();
    expect(confirmWaitEnded(met, days(1), true)).toBe('met');
  });

  it('reads none once the fix it stands on was reopened, before its date, and says so', () => {
    expect(confirmWaitOf(set, now, false, true)).toBeNull();
    expect(confirmWaitEnded(set, now, true)).toBe('withdrawn');
    expect(confirmWaitEnded(set, days(3), true), 'the reopen, not the date, ended it').toBe(
      'withdrawn',
    );
  });

  it('reads nothing on an item no wait was set on', () => {
    expect(confirmWaitOf(none, now, false, false)).toBeNull();
    expect(confirmWaitEnded(none, now, false)).toBeNull();
  });
});
