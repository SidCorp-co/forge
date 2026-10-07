import { describe, expect, it } from 'vitest';
import { declinedNotice, duplicateNotice, messageNotice } from './reporter-notices.js';
import { feedbackStandingOf } from './standing.js';
import {
  acceptRefusal,
  duplicateRefusal,
  messageRefusal,
  noteActRefusal,
  snoozeRefusal,
} from './verb-rules.js';

const now = new Date('2026-10-07T00:00:00Z');
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000);
const viewer = {
  isReporter: false,
  canTriage: true,
  canApproveRelease: false,
  canWrite: true,
  canAdmin: false,
};

describe('accept', () => {
  it('takes new and reopened, and refuses every other phase by name', () => {
    expect(acceptRefusal('new')).toBeNull();
    expect(acceptRefusal('reopened')).toBeNull();
    for (const phase of ['triaged', 'planned', 'resolved', 'verified', 'declined'] as const) {
      expect(acceptRefusal(phase)?.code).toBe('FEEDBACK_STATUS_INVALID');
    }
  });
});

describe('snooze', () => {
  it('takes a future date inside the limit with a reason', () => {
    expect(snoozeRefusal('new', inDays(1), 'wait for the release', now, 365)).toBeNull();
    expect(snoozeRefusal('new', inDays(365), 'a year exactly', now, 365)).toBeNull();
  });

  it('refuses now and the past, naming the date', () => {
    expect(snoozeRefusal('new', now, 'r', now, 365)?.code).toBe('FEEDBACK_SNOOZE_PAST');
    expect(snoozeRefusal('new', inDays(-1), 'r', now, 365)?.code).toBe('FEEDBACK_SNOOZE_PAST');
    expect(snoozeRefusal('new', new Date('nope'), 'r', now, 365)?.code).toBe(
      'FEEDBACK_SNOOZE_PAST',
    );
  });

  it('refuses a date past the limit, no reason, and any phase but new or reopened', () => {
    expect(snoozeRefusal('new', inDays(366), 'r', now, 365)?.code).toBe('FEEDBACK_SNOOZE_TOO_FAR');
    expect(snoozeRefusal('new', inDays(2), '  ', now, 365)?.code).toBe(
      'FEEDBACK_SNOOZE_REASON_REQUIRED',
    );
    expect(snoozeRefusal('declined', inDays(2), 'r', now, 365)?.code).toBe(
      'FEEDBACK_STATUS_INVALID',
    );
  });

  it('puts a snoozed item out of the viewer’s Needs you until its date', () => {
    const until = inDays(3).toISOString();
    const parked = feedbackStandingOf('new', null, [], 'Ann', viewer, null, {
      masterOwesTriage: false,
      carrierRelease: null,
      snoozedUntil: until,
    });
    expect(parked.attentionGroup).toBe('waiting');
    expect(parked.waitingOn.dueAt).toBe(until);
    const back = feedbackStandingOf('new', null, [], 'Ann', viewer, null);
    expect(back.attentionGroup).toBe('needs_you');
  });
});

describe('duplicate', () => {
  const root = { id: 'r', key: 'FB-1', status: 'new' as const, duplicateOfKey: null };

  it('refuses itself, a declined original and a chain, each by its own name', () => {
    expect(duplicateRefusal('r', root, [])?.code).toBe('FEEDBACK_DUPLICATE_SELF');
    expect(duplicateRefusal('x', { ...root, status: 'declined' }, [])?.code).toBe(
      'FEEDBACK_DUPLICATE_OF_DECLINED',
    );
    expect(duplicateRefusal('x', { ...root, duplicateOfKey: 'FB-9' }, [])?.code).toBe(
      'FEEDBACK_DUPLICATE_CHAIN',
    );
    expect(duplicateRefusal('x', root, [])).toBeNull();
  });
});

describe('messages', () => {
  it('refuses nothing to say, and a message that reaches no one with a bell', () => {
    expect(messageRefusal('reporter', '  ', 1)?.code).toBe('FEEDBACK_MESSAGE_EMPTY');
    expect(messageRefusal('reporter', 'hi', 0)?.code).toBe('FEEDBACK_MESSAGE_NO_RECIPIENT');
    expect(messageRefusal('all_reporters', 'hi', 0)?.code).toBe('FEEDBACK_MESSAGE_NO_RECIPIENT');
    expect(messageRefusal('all_reporters', 'hi', 2)).toBeNull();
  });

  it('lets an internal note reach no one, and needs only project.write', () => {
    expect(messageRefusal('internal', 'call her first', 0)).toBeNull();
    expect(noteActRefusal({ projectId: 'p', role: 'member', grants: [] })).toBeNull();
    expect(noteActRefusal({ projectId: 'p', role: null, grants: [] })?.code).toBe(
      'PERMISSION_FORBIDDEN',
    );
  });

  it('builds the reporter’s notices from the item and the words given, nothing else', () => {
    expect(declinedNotice('FB-2', 'Blue board', ' Brand guide. ')).toEqual({
      title: 'FB-2 was declined: Blue board',
      body: 'It will not be done.\nReason: Brand guide.',
    });
    expect(duplicateNotice('FB-3', 'Slow export', 'FB-1').body).toContain('FB-1');
    expect(messageNotice('FB-2', 'Blue board', '  Hello.  ')).toEqual({
      title: 'A message about FB-2: Blue board',
      body: 'Hello.',
    });
  });
});
