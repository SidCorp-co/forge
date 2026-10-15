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
      'ISS-9 has read Awaiting release for 3 days with no live job, run or lease behind it. ' +
        'The code carries a merge mark and nothing has moved the row since. ' +
        'It is waiting for a person to release it, and a person owes the next move.',
    );
    expect(body).not.toMatch(STORED_TIME);
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
        'for 3 days with no live job or run behind it, and a lease that establishes nothing either way.',
      );
      expect(`${title} ${body}`).not.toMatch(STORED_TIME);
      expect(`${title} ${body}`).not.toContain('awaiting_release');
    },
  );
});
