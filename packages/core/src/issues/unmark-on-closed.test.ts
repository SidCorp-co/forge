/**
 * ISS-1108 — `unmark` on a `closed` issue, refused in the application by name.
 *
 * Clearing the claim writes `merged_at = NULL` and does not touch `status`, so on a `closed` row
 * it produces the one state this issue makes unrepresentable. The database refuses it, but its
 * message is written for a close and says the issue "cannot enter `closed`" — an act nobody
 * attempted on a row already there — and it arrives as an unhandled Postgres exception, which the
 * route turns into a 500.
 *
 * The guard is therefore the UPDATE's own WHERE rather than a read above it: a caller's status is
 * stale the moment it is read, and a check-then-write leaves a window in which the row is closed by
 * somebody else and the trigger answers instead. Every case below holds that the refusal is the
 * caller's answer — named, carrying the order to take, and decided by the statement that writes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueStatuses } from '../db/schema.js';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-09-20T14:59:37.646Z');

/** The rows the guarded UPDATE returns: empty is "the row was closed, or is gone". */
let clearedRows: unknown[] = [{ id: ISSUE_ID }];
/** What the row reads as when the failed clear re-reads it. */
let rowNow: Record<string, unknown> | null = { id: ISSUE_ID, status: 'closed', mergedAt: AT };
/** The literal SQL of every UPDATE's WHERE, so "the guard is in the statement" is a reading. */
const whereSql: string[] = [];
const auditBodies: string[] = [];

function sqlText(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) return chunks.map(sqlText).join('');
  const name = (node as { name?: unknown }).name;
  if (typeof name === 'string') return name;
  const value = (node as { value?: unknown }).value;
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('') : '';
}

const update = vi.fn(() => ({
  set: () => ({
    where: (cond: unknown) => {
      whereSql.push(sqlText(cond));
      return {
        returning: async () => clearedRows,
        then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
      };
    },
  }),
}));
const select = vi.fn(() => ({
  from: () => ({
    where: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }),
  }),
}));
const insert = vi.fn(() => ({
  values: (row: { body: string }) => {
    auditBodies.push(row.body);
    return { returning: async () => [{ id: 'comment-1', body: row.body, parentId: null }] };
  },
}));
vi.mock('../db/client.js', () => ({ db: { update, select, insert } }));
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: async () => null,
  collectWorkEvidence: async () => ({ handoffCommitSha: null }),
}));
vi.mock('./read-service.js', () => ({ findIssueById: async () => rowNow }));

const { applyMergeMarker, MergeMarkerError } = await import('./merge-marker.js');
const { refuseUnmarkOnClosed } = await import('./merged-at.js');

const ACTOR = {
  agency: 'human' as const,
  commentAuthorId: '44444444-4444-4444-8444-444444444444',
  hookActor: {
    type: 'user' as const,
    id: '44444444-4444-4444-8444-444444444444',
    agency: 'human' as const,
  },
};
const ISSUE = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: AT };

const unmark = () => applyMergeMarker({ issue: ISSUE, op: 'unmark', actor: ACTOR });

beforeEach(() => {
  whereSql.length = 0;
  auditBodies.length = 0;
  clearedRows = [{ id: ISSUE_ID }];
  rowNow = { id: ISSUE_ID, status: 'closed', mergedAt: AT };
});

describe('the rule itself (ISS-1108)', () => {
  it('refuses an unmark on `closed`, naming the exit `closed` has and the one for non-work', () => {
    const refusal = refuseUnmarkOnClosed('closed');
    expect(refusal?.detail).toContain('`closed` means the work shipped');
    expect(refusal?.detail).toContain('reopen');
    expect(refusal?.detail).toContain('dropped');
    expect(refusal?.details).toEqual({
      status: 'closed',
      moveTo: 'reopen',
      useInstead: 'dropped',
    });
  });

  it('refuses no other status, `dropped` and `awaiting_release` included', () => {
    expect(issueStatuses.filter((s) => refuseUnmarkOnClosed(s) !== null)).toEqual(['closed']);
  });
});

describe('unmark, at the door a caller reaches (ISS-1108)', () => {
  it('decides on the UPDATE`s own WHERE, so no read can be stale by the time it writes', async () => {
    await unmark();
    expect(whereSql).toHaveLength(1);
    expect(whereSql[0]).toContain('status <>');
  });

  it('is refused under its own code when the guarded clear moves no row', async () => {
    clearedRows = [];
    const err = await unmark().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergeMarkerError);
    expect((err as InstanceType<typeof MergeMarkerError>).code).toBe('UNMARK_REQUIRES_NOT_CLOSED');
    expect((err as Error).message).toContain('Move it off `closed` first');
  });

  it('leaves no audit comment when it refuses', async () => {
    clearedRows = [];
    await unmark().catch(() => undefined);
    expect(auditBodies).toEqual([]);
  });

  it('calls a vanished row missing rather than closed', async () => {
    clearedRows = [];
    rowNow = null;
    const err = await unmark().catch((e: unknown) => e);
    expect((err as InstanceType<typeof MergeMarkerError>).code).toBe('ISSUE_NOT_FOUND');
  });

  it('refuses to explain away a zero-row clear on a row that is neither', async () => {
    clearedRows = [];
    rowNow = { id: ISSUE_ID, status: 'in_progress', mergedAt: AT };
    const err = await unmark().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MergeMarkerError);
    expect((err as Error).message).toContain('neither missing nor `closed`');
  });

  it('still clears the claim on an issue the guard admits', async () => {
    const res = await unmark();
    expect(res.action).toBe('unmarked');
    expect(auditBodies).toHaveLength(1);
  });
});
