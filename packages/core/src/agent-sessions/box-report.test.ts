import { describe, expect, it } from 'vitest';
import { type LedgerRow, newestReports } from './box-report.js';

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  session_id: 's1',
  incarnation: 'live',
  work: 'runnable',
  blocker_kind: null,
  waiting_on: null,
  observed_at: '2026-10-16T08:00:00.000Z',
  work_since: '2026-10-16T07:40:00.000Z',
  ...over,
});

describe('newestReports (ISS-1228)', () => {
  it("answers each session with the box's own words", () => {
    const out = newestReports([
      row({ work: 'blocked', blocker_kind: 'human', waiting_on: 'approve the restore' }),
    ]);
    expect(out.get('s1')).toEqual({
      incarnation: 'live',
      work: 'blocked',
      blockerKind: 'human',
      waitingOn: 'approve the restore',
      observedAt: '2026-10-16T08:00:00.000Z',
      since: '2026-10-16T07:40:00.000Z',
    });
  });

  it('says since when the box has reported this wait, apart from when it last reported it', () => {
    const out = newestReports([
      row({
        work: 'blocked',
        blocker_kind: 'human',
        work_since: new Date('2026-10-16T07:05:00.000Z'),
      }),
    ]);
    expect(out.get('s1')?.since).toBe('2026-10-16T07:05:00.000Z');
    expect(out.get('s1')?.observedAt).toBe('2026-10-16T08:00:00.000Z');
  });

  it('keeps the newest of the entries several runs filed for one session, in any order', () => {
    const older = row({ work: 'blocked', observed_at: new Date('2026-10-16T07:00:00.000Z') });
    const newer = row({ work: 'runnable', observed_at: '2026-10-16T08:00:00.000Z' });
    expect(newestReports([newer, older]).get('s1')?.work).toBe('runnable');
    expect(newestReports([older, newer]).get('s1')?.work).toBe('runnable');
  });

  it('reports nothing for a session no entry names', () => {
    const out = newestReports([row({ session_id: 's2' })]);
    expect(out.has('s1')).toBe(false);
    expect(newestReports([]).size).toBe(0);
  });
});
