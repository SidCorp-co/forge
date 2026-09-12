import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { ageSeconds, bucketOfStatus, foldBuckets } from './pulse-folds.js';
import {
  PULSE_AWAITING_RELEASE_STATUSES,
  PULSE_FINISHED_STATUSES,
  PULSE_HUMAN_BLOCKED_STATUSES,
  PULSE_IN_PROGRESS_STATUSES,
  PULSE_OPEN_STATUSES,
} from './pulse-types.js';

describe('the four buckets partition the issue lifecycle', () => {
  it('places every status except closed, dropped and draft in exactly one bucket', () => {
    const unplaced = issueStatuses.filter(
      (s) =>
        bucketOfStatus(s) === null &&
        s !== 'draft' &&
        !PULSE_FINISHED_STATUSES.includes(s as never),
    );
    expect(unplaced).toEqual([]);
  });

  it('places none of them in two buckets', () => {
    const all = [
      ...PULSE_OPEN_STATUSES,
      ...PULSE_IN_PROGRESS_STATUSES,
      ...PULSE_AWAITING_RELEASE_STATUSES,
      ...PULSE_HUMAN_BLOCKED_STATUSES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves closed, dropped and draft out of every bucket', () => {
    expect(bucketOfStatus('closed')).toBeNull();
    expect(bucketOfStatus('dropped')).toBeNull();
    expect(bucketOfStatus('draft')).toBeNull();
  });
});

describe('foldBuckets', () => {
  it('sums a status into its bucket for the workspace and for its own project', () => {
    const { total, byProject } = foldBuckets([
      { projectId: 'a', status: 'open', n: 5 },
      { projectId: 'b', status: 'open', n: 2 },
      { projectId: 'a', status: 'in_progress', n: 3 },
      { projectId: 'a', status: 'waiting', n: 1 },
      { projectId: 'a', status: 'awaiting_release', n: 4 },
    ]);
    expect(total).toEqual({ open: 7, inProgress: 3, awaitingRelease: 4, humanBlocked: 1 });
    expect(byProject.get('a')).toEqual({
      open: 5,
      inProgress: 3,
      awaitingRelease: 4,
      humanBlocked: 1,
    });
    expect(byProject.get('b')).toEqual({
      open: 2,
      inProgress: 0,
      awaitingRelease: 0,
      humanBlocked: 0,
    });
  });

  it('drops the finished statuses rather than counting them as backlog', () => {
    const { total } = foldBuckets([
      { projectId: 'a', status: 'closed', n: 3238 },
      { projectId: 'a', status: 'dropped', n: 664 },
      { projectId: 'a', status: 'draft', n: 30 },
      { projectId: 'a', status: 'open', n: 1 },
    ]);
    expect(total).toEqual({ open: 1, inProgress: 0, awaitingRelease: 0, humanBlocked: 0 });
  });
});

describe('ageSeconds', () => {
  const now = new Date('2026-09-12T06:00:00.000Z');

  it('is the elapsed whole seconds', () => {
    expect(ageSeconds('2026-09-12T05:00:00.000Z', now)).toBe(3600);
  });

  it('is null where nothing has happened', () => {
    expect(ageSeconds(null, now)).toBeNull();
  });

  it('is zero rather than negative when the stamp lies ahead of the reader', () => {
    expect(ageSeconds('2026-09-12T07:00:00.000Z', now)).toBe(0);
  });
});
