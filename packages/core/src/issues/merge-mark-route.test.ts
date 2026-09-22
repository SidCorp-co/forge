/**
 * ISS-1126 criterion 14, at the runtime criteria 3 and 4 name: `POST|DELETE /api/issues/:id/merge`.
 * Why the route and not `applyMergeMarker`: docs/modules/issues/merge-mark.md.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-09-20T14:59:37.646Z');
const OBSERVED_SHA = '9a78b0c93f1a2b3c4d5e6f708192a3b4c5d6e7f8';

let issueRow: Record<string, unknown> = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: null };
/** The merged pull request `observedMergeForIssue` finds, or none. */
let projectionRows: unknown[] = [];
/** What `UPDATE ... RETURNING` hands back, which is the row the answer describes. */
let stampedRows: unknown[] = [];
/** What the row already held, read back when the gated UPDATE moved nothing. */
let heldRow: Record<string, unknown> = { mergedAt: null, mergedCommitSha: null };
let issueAfter: Record<string, unknown> = {};
/** Reset per request: the route reads the issue first, `readBack` reads the held row second. */
let limitCalls = 0;

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            limitCalls += 1;
            return limitCalls === 1 ? [issueRow] : [heldRow];
          },
          orderBy: () => ({ limit: async () => projectionRows }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => stampedRows,
          then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
        }),
      }),
    }),
    insert: () => ({
      values: (row: { body: string }) => ({
        returning: async () => [{ id: 'comment-1', body: row.body, parentId: null }],
      }),
    }),
  },
}));

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async () => ({ role: 'member' }),
  assertProjectRole: () => undefined,
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-9');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  restActor: () => ({ type: 'user', id: 'user-9', agency: 'human' }),
}));
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: async () => null,
  collectWorkEvidence: async () => ({ handoffCommitSha: null }),
}));
vi.mock('../pipeline/hooks.js', () => ({ hooks: { emit: async () => undefined } }));
vi.mock('./read-service.js', () => ({ findIssueById: async () => issueAfter }));
vi.mock('../integrations/github/contract-check.js', () => ({
  openPullRequestsForIssue: async () => [],
}));
vi.mock('../integrations/github/projection-health.js', () => ({
  describeEmptyProjection: () => null,
  projectionPipeReport: async () => ({
    projectId: PROJECT_ID,
    rows: 0,
    bindings: 1,
    inbound: { count: 0, lastAt: null },
  }),
}));

const { issueMergeRoutes } = await import('./merge-routes.js');
const { errorHandler } = await import('../middleware/error.js');

// biome-ignore lint/suspicious/noExplicitAny: test-only mount, as the integration harness does
const app: any = new Hono();
app.route('/api/issues', issueMergeRoutes);
app.onError(errorHandler);

const call = (method: 'POST' | 'DELETE', body: unknown) => {
  limitCalls = 0;
  return app.request(`/api/issues/${ISSUE_ID}/merge`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
};

type Answer = { id: string; action: string; mark: string; detail: string };
const mark = async (body: unknown = { target: 'main' }): Promise<Answer> => {
  const res = await call('POST', body);
  expect(res.status).toBe(200);
  return (await res.json()) as Answer;
};

function asAsserted(sha: string | null = null) {
  projectionRows = [];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: sha }];
  issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: sha };
}

function asObserved(sha = OBSERVED_SHA) {
  projectionRows = [{ sha, at: AT }];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: sha }];
  issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: sha };
}

beforeEach(() => {
  issueRow = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: null };
  heldRow = { mergedAt: null, mergedCommitSha: null };
  asAsserted();
});

describe('POST /api/issues/:id/merge', () => {
  it('answers a claim and a witnessed merge with different marks', async () => {
    asAsserted();
    const claimed = await mark();
    asObserved();
    const witnessed = await mark();

    expect(claimed.mark).toBe('asserted');
    expect(witnessed.mark).toBe('observed');
    expect(claimed.detail).not.toBe(witnessed.detail);
    expect(claimed.action).toBe(witnessed.action);
  });

  it('tells a caller whose merge was not witnessed that what it wrote is a claim', async () => {
    const claimed = await mark({ target: 'main', commit: 'abc1234' });
    expect(claimed.detail).toContain('CLAIM Forge did not observe');
    expect(claimed.detail).toContain('abc1234');
    expect(claimed.detail).toContain('NOT in `merged_commit_sha`');
  });

  it('carries the sha it witnessed in the answer, so the word can be checked', async () => {
    asObserved();
    const witnessed = await mark();
    expect(witnessed.detail).toContain(OBSERVED_SHA);
    expect(witnessed.detail).not.toContain('CLAIM Forge did not observe');
  });

  it('calls a stamp of the empty string a claim, not a merge it witnessed', async () => {
    asAsserted('');
    expect((await mark()).mark).toBe('asserted');
  });

  it('does not tell a caller its own commit was overruled when the column holds it', async () => {
    asObserved();
    const agreeing = await mark({ target: 'main', commit: OBSERVED_SHA.toUpperCase() });
    expect(agreeing.detail).not.toContain('is not what the column holds');
  });

  it('tells a caller that named a different commit that the column holds another', async () => {
    asObserved();
    const disagreeing = await mark({ target: 'main', commit: 'abc1234' });
    expect(disagreeing.detail).toContain('abc1234');
    expect(disagreeing.detail).toContain('is not what the column holds');
  });
});

describe('a second mark over a row that already holds a merge Forge witnessed', () => {
  /** The gated UPDATE moves nothing, so the answer describes the stamp already there. */
  function alreadyObserved() {
    projectionRows = [];
    stampedRows = [];
    heldRow = { mergedAt: AT, mergedCommitSha: OBSERVED_SHA };
    issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: OBSERVED_SHA };
    issueRow = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: AT };
  }

  it('reports the kind the row holds, not the branch this call took', async () => {
    alreadyObserved();
    const answer = await mark();
    expect(answer.action).toBe('already_merged');
    expect(answer.mark).toBe('observed');
  });

  it('does not tell a caller its commit was overruled by the very commit it named', async () => {
    alreadyObserved();
    const answer = await mark({ target: 'main', commit: OBSERVED_SHA });
    expect(answer.detail).not.toContain('is not what the column holds');
  });

  it('still tells a caller that named a different commit which one the column holds', async () => {
    alreadyObserved();
    const answer = await mark({ target: 'main', commit: 'abc1234' });
    expect(answer.detail).toContain('abc1234');
    expect(answer.detail).toContain('is not what the column holds');
  });
});

describe('DELETE /api/issues/:id/merge', () => {
  it('answers unmarked rather than the kind it cleared', async () => {
    asObserved();
    issueAfter = { id: ISSUE_ID, mergedAt: null, mergedCommitSha: null };
    issueRow = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: AT };
    const res = await call('DELETE', {});
    expect(res.status).toBe(200);
    const cleared = (await res.json()) as Answer;
    expect(cleared.mark).toBe('unmarked');
    expect(cleared.detail).toContain('no merged mark');
  });
});
