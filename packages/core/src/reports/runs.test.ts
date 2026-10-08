import type { ReportRun } from '@forge/contracts/report-queries';
import { describe, expect, it } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import { keptUntil, runReadRefusal } from './runs.js';

// A run is read back only by the person it was read as, and only while it is kept: past 30 days it
// is gone, named as such, never answered with a frame that outlived its keep.

const READ_AT = new Date('2026-09-01T10:00:00.000Z');
const run: ReportRun = {
  runId: '0b9e4f5e-58a1-4a3e-9d35-0c1a3f1f7a11',
  queryId: 'progress-by-requirement',
  version: 1,
  params: {},
  projectId: 'p1',
  actor: { kind: 'human', id: 'asker' },
  asOf: READ_AT.toISOString(),
  frame: { fields: [{ name: 'a', type: 'number', label: 'A' }], rows: [{ a: 1 }] },
};
const stored = { run, permission: 'project.read', expiresAt: keptUntil(READ_AT) };
const DAY = 24 * 60 * 60 * 1000;

describe('who may read a stored run, and until when', () => {
  it('keeps a run exactly 30 days from its read', () => {
    expect(keptUntil(READ_AT).toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('lets the person it was read as read it inside its keep', () => {
    expect(runReadRefusal(stored, 'asker', new Date(READ_AT.getTime() + 29 * DAY))).toBeNull();
  });

  it('refuses another member by name, since the frame is what its asker may see', () => {
    const refusal = runReadRefusal(stored, 'someone-else', READ_AT);
    expect(isRefusal(refusal, 'REPORT_RUN_READ_FORBIDDEN')).toBe(true);
    expect(refusal?.message).toContain('only the person it was read as may read or show it');
  });

  it('reads a run older than 30 days as gone, by name, with when it expired', () => {
    const refusal = runReadRefusal(stored, 'asker', new Date(READ_AT.getTime() + 30 * DAY + 1));
    expect(isRefusal(refusal, 'REPORT_RUN_EXPIRED')).toBe(true);
    expect(refusal?.message).toContain(
      'is gone: a run is kept 30 days and this one expired at 2026-10-01T10:00:00.000Z',
    );
  });

  it('is gone at the very moment its keep ends, not a moment after', () => {
    expect(
      isRefusal(runReadRefusal(stored, 'asker', keptUntil(READ_AT)), 'REPORT_RUN_EXPIRED'),
    ).toBe(true);
  });
});
