import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { idleNotice } = await import('./idle-issues.js');

const now = new Date('2026-10-15T12:00:00.000Z');

/** Postgres's own text for a timestamptz, as a raw query hands it back. */
const STORED_TIME = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

function record(lease: string) {
  return {
    status: 'awaiting_release',
    since: '2026-10-12 09:00:00.5+00',
    reason: 'the code carries a merge mark and nothing has moved the row since',
    waitingFor: 'a person to release it',
    owes: 'human',
    lease,
  };
}

describe('the idle-issue notice, in the words a reader uses (ISS-1229)', () => {
  it('says how long the issue has stood at its status, never the stored time', () => {
    const { title, body } = idleNotice({
      ref: 'ISS-9',
      projectName: 'Desk',
      record: record('none'),
      now,
    });
    expect(title).toBe('ISS-9 reads Awaiting release and nothing is working it — Desk');
    expect(body).toBe(
      'Nothing has worked it for 3 days: the code carries a merge mark and nothing has moved the row since. ' +
        'It waits for a person to release it; a person owes that move.',
    );
    expect(body).not.toMatch(STORED_TIME);
  });

  // The master's r15 repair: the body read three sentences and some 55 words.
  it('says what is true and what it waits for, in at most two sentences', () => {
    const { body } = idleNotice({
      ref: 'ISS-15',
      projectName: 'Desk',
      record: {
        ...record('none'),
        status: 'open',
        since: '2026-10-15 11:00:00+00',
        reason: 'no runner that takes this project’s work is connected, so nothing can pick it up',
        waitingFor: 'a run to be dispatched onto it',
      },
      now,
    });
    expect(body.split(/(?<=[.!?])\s+/)).toHaveLength(2);
    expect(body).toBe(
      'Nothing has worked it for 1 hour: no runner that takes this project’s work is connected, so nothing can pick it up. ' +
        'It waits for a run to be dispatched onto it; a person owes that move.',
    );
  });

  it.each(['shared', 'malformed'])(
    'draws no conclusion from a %s lease, and still prints no stored time',
    (lease) => {
      const { title, body } = idleNotice({
        ref: 'ISS-9',
        projectName: 'Desk',
        record: record(lease),
        now,
      });
      expect(title).toBe('ISS-9 reads Awaiting release and no live work could be confirmed — Desk');
      expect(body).toContain(
        'No live work could be confirmed for 3 days: the code carries a merge mark',
      );
      expect(`${title} ${body}`).not.toMatch(STORED_TIME);
      expect(`${title} ${body}`).not.toContain('awaiting_release');
    },
  );
});

describe('the idle-issue notice of a held release', () => {
  it('names the hold in its first sentence and leaves the remedy to the hold, in two sentences', () => {
    const { body } = idleNotice({
      ref: 'ISS-9',
      projectName: 'Desk',
      record: {
        ...record('none'),
        reason:
          'the automatic release is holding it (RELEASE_CRITERIA_UNEARNED): criterion 3: unjudged. A person clears this.',
        waitingFor: 'a verdict on each criterion named',
      },
      now,
    });
    expect(body).toBe(
      'Nothing has worked it for 3 days: the automatic release is holding it (RELEASE_CRITERIA_UNEARNED): criterion 3: unjudged. ' +
        'It waits for a verdict on each criterion named; a person owes that move.',
    );
  });
});
