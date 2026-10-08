import type { ProjectStatus } from '@forge/contracts/project-status';
import type { StatusReportDiff } from '@forge/contracts/status-reports';
import { describe, expect, it } from 'vitest';
import { slotAt } from '../schedules/cron.js';
import { digestText } from './digest.js';
import copy from './digest-copy.json' with { type: 'json' };

// The first lines a recipient reads, in their language: what shipped, what is late, who is waited
// on, the next release with its date, and what changed since the last report, every figure the
// stored report's or the diff's.

const status = {
  name: 'Hop',
  asOf: '2026-10-05T02:00:00.000Z',
  days: 7,
  shipped: { releaseCount: 2, issueCount: 5 },
  late: { items: [{ key: 'REQ-4' }] },
  waits: { peopleCount: 1, people: [{ key: 'ISS-9' }] },
  nextRelease: {
    version: '0.4.0',
    forecast: {
      delivery: {
        shipped: null,
        inHands: { p50At: '2026-10-09T03:00:00.000Z' },
        landing: { kind: 'landed' },
      },
    },
  },
} as unknown as ProjectStatus;

const diff = {
  previousAsOf: '2026-09-28T02:00:00.000Z',
  diff: {
    shipped: [{}],
    newlyLate: [{}],
    noLongerWaiting: [],
    moved: [{}, {}],
  } as unknown as StatusReportDiff,
};

describe('a status report notice', () => {
  it('reads its first lines in English, dated in the schedule zone', () => {
    const { title, body } = digestText(status, diff, 'en', 'Asia/Ho_Chi_Minh');
    expect(title).toBe('Hop status report, 5 Oct 2026');
    expect(body.split('\n')).toEqual([
      'Shipped in the last 7 days: 2 releases, 5 issues',
      'Late: 1 (REQ-4)',
      'Waiting on people: 1 (ISS-9)',
      'Next release: 0.4.0, around 9 Oct 2026',
      'Since the last report (28 Sept 2026): 1 releases shipped, 1 newly late, 0 no longer waiting, 2 dates moved',
    ]);
  });

  it('reads them in Vietnamese for a Vietnamese reader, and says the first report has nothing before it', () => {
    const { title, body } = digestText(status, null, 'vi', 'Asia/Ho_Chi_Minh');
    expect(
      title.startsWith(copy.vi.title.replace('{project}', 'Hop').split('{date}')[0] as string),
    ).toBe(true);
    expect(body).toContain(copy.vi.next.split('{version}')[0] as string);
    expect(body.split('\n').at(-1)).toBe(copy.vi.first);
  });
});

describe('the period a status_report fire answers', () => {
  it('is the latest slot of the cron at or before the fire, read in the schedule zone', () => {
    const fire = new Date('2026-10-05T02:00:30.000Z');
    expect(slotAt('0 9 * * 1', fire, 'Asia/Ho_Chi_Minh').toISOString()).toBe(
      '2026-10-05T02:00:00.000Z',
    );
    const later = new Date('2026-10-08T10:00:00.000Z');
    expect(slotAt('0 9 * * 1', later, 'Asia/Ho_Chi_Minh').toISOString()).toBe(
      '2026-10-05T02:00:00.000Z',
    );
    expect(slotAt('0 9 * * 1', later, null).toISOString()).toBe('2026-10-05T09:00:00.000Z');
  });
});
