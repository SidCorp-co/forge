/**
 * ISS-1108 — `unmark` on a `closed` issue, refused in the application by name.
 *
 * `clearIssueMerge` writes `merged_at = NULL` and does not touch `status`, so on a `closed` row
 * it produces the one state this issue makes unrepresentable. The database refuses it, but its
 * message is written for a close and says the issue "cannot enter `closed`" — an act nobody
 * attempted on a row already there — and it arrives as an unhandled Postgres exception, which
 * the route turns into a 500. What every case below holds is that the refusal is the caller's
 * answer instead: named, carrying the order to take, and taken BEFORE the write is attempted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueStatuses } from '../db/schema.js';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-09-20T14:59:37.646Z');

/** Every `set()` the run reached, so "no write was attempted" is a reading and not a hope. */
const updates: Array<Record<string, unknown>> = [];
/** Every audit comment body the run wrote. */
const auditBodies: string[] = [];

const update = vi.fn(() => ({
  set: (row: Record<string, unknown>) => {
    updates.push(row);
    return {
      where: () => ({
        returning: async () => [{ mergedAt: null, mergedCommitSha: null }],
        then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
      }),
    };
  },
}));
const select = vi.fn(() => ({
  from: () => ({
    where: () => ({
      limit: async () => [],
      orderBy: () => ({ limit: async () => [] }),
    }),
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
vi.mock('./read-service.js', () => ({
  findIssueById: async () => ({ id: ISSUE_ID, mergedAt: null, mergedCommitSha: null }),
}));

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

beforeEach(() => {
  updates.length = 0;
  auditBodies.length = 0;
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
    const refused = issueStatuses.filter((s) => refuseUnmarkOnClosed(s) !== null);
    expect(refused).toEqual(['closed']);
  });
});

describe('unmark, at the door a caller reaches (ISS-1108)', () => {
  it('is refused on a closed issue under its own code, not as a database exception', async () => {
    const err = await applyMergeMarker({
      issue: { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: AT, status: 'closed' },
      op: 'unmark',
      actor: ACTOR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergeMarkerError);
    expect((err as InstanceType<typeof MergeMarkerError>).code).toBe('UNMARK_REQUIRES_NOT_CLOSED');
    expect((err as Error).message).toContain('Move it off `closed` first');
  });

  it('attempts no write and leaves no audit comment when it refuses', async () => {
    await applyMergeMarker({
      issue: { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: AT, status: 'closed' },
      op: 'unmark',
      actor: ACTOR,
    }).catch(() => undefined);

    expect(updates).toEqual([]);
    expect(auditBodies).toEqual([]);
  });

  it('still clears the claim on an issue that is not closed', async () => {
    const res = await applyMergeMarker({
      issue: { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: AT, status: 'awaiting_release' },
      op: 'unmark',
      actor: ACTOR,
    });

    expect(res.action).toBe('unmarked');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ mergedAt: null, mergedCommitSha: null });
  });

  it('leaves a mark on a closed issue alone: the refusal is the unmark`s, not the door`s', async () => {
    const res = await applyMergeMarker({
      issue: { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: null, status: 'closed' },
      op: 'mark',
      target: 'main',
      actor: ACTOR,
    });

    expect(res.action).toBe('merged');
  });
});
