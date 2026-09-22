/**
 * ISS-1126 — the surfaces that report a merge mark report the two kinds differently.
 *
 * Each case builds an asserted mark and an observed one through the same call and asserts the
 * answers DIFFER. Asserting a key is present would stay green through the defect this issue is
 * about, which is a system where both states exist and every surface renders them alike.
 *
 * The observed branch is driven by making `observedMergeForIssue`'s SELECT return a merged pull
 * request row. On a real database it returns nothing, because `repo_pull_requests` is empty
 * wherever no webhook delivery has landed — which is why the branch is exercised here or nowhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-09-20T14:59:37.646Z');
const OBSERVED_SHA = '9a78b0c93f1a2b3c4d5e6f708192a3b4c5d6e7f8';

/** The row `observedMergeForIssue`'s SELECT finds, or none. */
let projectionRows: unknown[] = [];
/** What the UPDATE ... RETURNING gives back. */
let stampedRows: unknown[] = [];
/** What `findIssueById` reports after the write. */
let issueAfter: Record<string, unknown> = {};

const update = vi.fn(() => ({
  set: () => ({
    where: () => ({
      returning: async () => stampedRows,
      then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
    }),
  }),
}));
const select = vi.fn(() => ({
  from: () => ({
    where: () => ({
      limit: async () => projectionRows,
      orderBy: () => ({ limit: async () => projectionRows }),
    }),
  }),
}));
/** Every audit comment body this suite wrote, in order. */
const auditBodies: string[] = [];
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
  findIssueById: async () => issueAfter,
}));

const { applyMergeMarker } = await import('./merge-marker.js');
const { serialize, serializeListRow, serializeManifest } = await import(
  '../mcp/tools/forge-issues.js'
);
const { serializeRestListRow } = await import('./list-projection.js');

const ACTOR = {
  agency: 'human' as const,
  commentAuthorId: '44444444-4444-4444-8444-444444444444',
  hookActor: {
    type: 'user' as const,
    id: '44444444-4444-4444-8444-444444444444',
    agency: 'human' as const,
  },
};
const ISSUE = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: null };

function asAsserted() {
  projectionRows = [];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: null }];
  issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: null };
}

function asObserved() {
  projectionRows = [{ sha: OBSERVED_SHA, at: AT }];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: OBSERVED_SHA }];
  issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: OBSERVED_SHA };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditBodies.length = 0;
});

describe('the answer a caller that marks a merge is given', () => {
  it('names the kind it wrote, and the two kinds do not share an answer', async () => {
    asAsserted();
    const claimed = await applyMergeMarker({
      issue: ISSUE,
      op: 'mark',
      target: 'main',
      commit: 'abc1234',
      actor: ACTOR,
    });
    asObserved();
    const witnessed = await applyMergeMarker({
      issue: ISSUE,
      op: 'mark',
      target: 'main',
      actor: ACTOR,
    });

    expect(claimed.mark).toBe('asserted');
    expect(witnessed.mark).toBe('observed');
    expect(claimed.markDetail).not.toBe(witnessed.markDetail);
    // `action` is the field that existed before, and it is the same word for both. That is the
    // whole reason `mark` had to be added rather than read off it.
    expect(claimed.action).toBe(witnessed.action);
  });

  it('tells a caller whose mark was not observed that what it wrote is a claim', async () => {
    asAsserted();
    const claimed = await applyMergeMarker({
      issue: ISSUE,
      op: 'mark',
      target: 'main',
      actor: ACTOR,
    });
    expect(claimed.markDetail).toContain('CLAIM Forge did not observe');
  });

  it('gives the audit trail and the caller the same sentence, not two accounts of one row', async () => {
    asAsserted();
    const claimed = await applyMergeMarker({
      issue: ISSUE,
      op: 'mark',
      target: 'main',
      actor: ACTOR,
    });
    expect(auditBodies).toHaveLength(1);
    expect(auditBodies[0]).toContain(claimed.markDetail);
  });

  it('reports an unmark as unmarked rather than as the kind it cleared', async () => {
    asObserved();
    issueAfter = { id: ISSUE_ID, mergedAt: null, mergedCommitSha: null };
    const cleared = await applyMergeMarker({
      issue: { ...ISSUE, mergedAt: AT },
      op: 'unmark',
      actor: ACTOR,
    });
    expect(cleared.mark).toBe('unmarked');
  });
});

describe('the projections an agent reads an issue through', () => {
  /** Only the fields these serializers touch; the mark is the subject and the rest is scaffolding. */
  const row = {
    id: ISSUE_ID,
    issSeq: 7,
    title: 'a merge Forge did not observe',
    description: null,
    descriptionFormat: 'markdown',
    plan: null,
    acceptanceCriteria: null,
    sessionContext: null,
    releaseNotes: null,
    status: 'developed',
    waitingKind: null,
    priority: 'critical',
    category: 'bug',
    complexity: 'm',
    assigneeId: null,
    reopenCount: 0,
    mergedAt: AT,
    createdAt: AT,
    updatedAt: AT,
  };
  const asserted = { ...row, mergedCommitSha: null };
  const observed = { ...row, mergedCommitSha: OBSERVED_SHA };

  it('reports the kind on the single-issue answer, differently for each', () => {
    const a = serialize(asserted as never, 'ISS');
    const o = serialize(observed as never, 'ISS');
    expect(a.mergeMark).toBe('asserted');
    expect(o.mergeMark).toBe('observed');
    expect(a.mergeMark).not.toBe(o.mergeMark);
  });

  it('reports the kind on every browse row, differently for each', () => {
    const a = serializeListRow(asserted as never, 'ISS');
    const o = serializeListRow(observed as never, 'ISS');
    expect(a.mergeMark).toBe('asserted');
    expect(o.mergeMark).toBe('observed');
  });

  it('reports the kind on the lean manifest, differently for each', () => {
    const a = serializeManifest(asserted as never, 'ISS');
    const o = serializeManifest(observed as never, 'ISS');
    expect(a.mergeMark).toBe('asserted');
    expect(o.mergeMark).toBe('observed');
  });

  it('reports the kind on the REST list row, differently for each', () => {
    expect(serializeRestListRow(asserted, 'ISS').mergeMark).toBe('asserted');
    expect(serializeRestListRow(observed, 'ISS').mergeMark).toBe('observed');
  });

  it('carries the commit itself where there is one, so the kind can be checked', () => {
    expect(serialize(observed as never, 'ISS').mergedCommitSha).toBe(OBSERVED_SHA);
    expect(serialize(asserted as never, 'ISS').mergedCommitSha).toBeNull();
  });
});
