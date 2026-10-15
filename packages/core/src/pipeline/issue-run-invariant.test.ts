import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { orphanNotice } = await import('./issue-run-invariant.js');

const now = new Date('2026-10-15T12:00:00.000Z');

/** Postgres's own text for a timestamptz, as a raw query hands it back. */
const STORED_TIME = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

describe('the orphan-assertion notice, in the words a reader uses (ISS-1229)', () => {
  const notice = orphanNotice({
    ref: 'ISS-78',
    projectName: 'Desk',
    status: 'in_progress',
    since: '2026-10-15 10:26:16.817935+00',
    now,
  });

  it('names the issue with its project', () => {
    expect(notice.title).toBe('ISS-78 says work is in progress with no run behind it — Desk');
  });

  it('says how long the issue has asserted work, never the stored time', () => {
    expect(notice.body).toBe(
      'ISS-78 has read In progress for 1 hour and no job, issue run or run session is live for it.',
    );
    expect(notice.body).not.toMatch(STORED_TIME);
  });

  it('names the status as the screen does, never its stored form', () => {
    expect(notice.body).not.toContain('in_progress');
  });
});
