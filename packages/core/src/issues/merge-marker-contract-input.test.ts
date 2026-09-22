/**
 * ISS-1072 — a merged mark is one of the five records `statusEntryCriteria` can
 * declare, and it is NOT written through `updateIssueFields`.
 *
 * That is the whole reason this announcement has its own line here. The mark
 * stamps `merged_at` directly, so the emit `update-service.ts` makes never fires
 * for it — and without this one, a check run keeps saying a merged mark is
 * missing on an issue that has just been marked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

let stampedRows: unknown[] = [
  { mergedAt: new Date('2026-09-17T00:00:00Z'), mergedCommitSha: 'abc1234' },
];
const updateReturning = vi.fn(async () => stampedRows);
const updateWhere = vi.fn(() => ({
  returning: updateReturning,
  then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
}));
const update = vi.fn(() => ({ set: () => ({ where: updateWhere }) }));
const select = vi.fn(() => ({
  from: () => ({
    where: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }),
  }),
}));
const insert = vi.fn(() => ({
  values: () => ({ returning: async () => [{ id: 'comment-1', body: 'b', parentId: null }] }),
}));
vi.mock('../db/client.js', () => ({ db: { update, select, insert } }));

vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: async () => null,
  collectWorkEvidence: async () => ({ handoffCommitSha: null }),
}));

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('./read-service.js', () => ({
  findIssueById: async () => ({ id: ISSUE_ID, mergedAt: null, mergedCommitSha: null }),
}));

const { hooks } = await import('../pipeline/hooks.js');
const { applyMergeMarker } = await import('./merge-marker.js');

/** Every `contractInputChanged` this suite heard, on the one bus the writer emits to. */
const heard: { projectId: string; issueId?: string; reason: string }[] = [];
hooks.on(
  'contractInputChanged',
  async (payload) => {
    heard.push(payload);
  },
  { name: 'merge-marker-test-listener' },
);

const ACTOR = {
  agency: 'human' as const,
  commentAuthorId: '44444444-4444-4444-8444-444444444444',
  hookActor: {
    type: 'user' as const,
    id: '44444444-4444-4444-8444-444444444444',
    agency: 'human' as const,
  },
};

const issue = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: null };

beforeEach(() => {
  heard.length = 0;
  vi.clearAllMocks();
  stampedRows = [{ mergedAt: new Date('2026-09-17T00:00:00Z'), mergedCommitSha: 'abc1234' }];
});

describe('a merged mark announces its own contract input', () => {
  it('announces a mark, naming the issue and its project', async () => {
    await applyMergeMarker({ issue, op: 'mark', target: 'main', actor: ACTOR });
    expect(heard).toEqual([
      { projectId: PROJECT_ID, issueId: ISSUE_ID, reason: 'merged mark written' },
    ]);
  });

  it('announces an unmark in its own words, never the mark`s', async () => {
    await applyMergeMarker({
      issue: { ...issue, mergedAt: new Date() },
      op: 'unmark',
      actor: ACTOR,
    });
    expect(heard).toEqual([
      { projectId: PROJECT_ID, issueId: ISSUE_ID, reason: 'merged mark cleared' },
    ]);
  });

  it('announces a repeat mark that stamped nothing, because the reader cannot know it did not', async () => {
    stampedRows = [];
    await applyMergeMarker({ issue, op: 'mark', actor: ACTOR });
    expect(heard).toHaveLength(1);
  });
});
