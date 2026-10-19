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
}));
vi.mock('../pipeline/hooks.js', () => ({ hooks: { emit: async () => undefined } }));
/** The shape `landing-evidence.ts` reads off the project's kind, set per case. */
let shape: 'git' | 'outside_git' = 'git';
// A git mark's commit is resolved by the project's repository (ISS-1350); this one holds every
// commit asked for, padded out to the whole sha it resolves a prefix to.
vi.mock('./commit-landing.js', async (original) => ({
  ...(await original<typeof import('./commit-landing.js')>()),
  resolveMarkCommit: async ({ commit }: { commit: string }) => ({
    ok: true as const,
    sha: commit.toLowerCase().padEnd(40, '0'),
    repository: 'SidCorp-co/specimen',
  }),
  // A commit named over a witnessed merge is read as this issue's landing (ISS-1421 round 7); this
  // repository says it is another issue's.
  readCommitLanding: async ({ commit }: { commit: string }) => ({
    ok: false as const,
    code: 'COMMIT_NOT_THIS_ISSUE' as const,
    detail: `commit ${commit} in SidCorp-co/specimen is not ISS-7's landing`,
    details: { commit },
  }),
}));
vi.mock('./landing-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./landing-evidence.js')>()),
  readLandingShape: async () => shape,
}));
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
  stampedRows = [{ mergedAt: AT, mergedCommitSha: sha, mergedLanding: null }];
  issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: sha, mergedLanding: null };
}

function asObserved(sha = OBSERVED_SHA) {
  projectionRows = [{ sha, at: AT }];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: sha, mergedLanding: null }];
  issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: sha, mergedLanding: null };
}

function asLanded(landing: string) {
  projectionRows = [];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: null, mergedLanding: landing }];
  issueAfter = { id: ISSUE_ID, mergedAt: AT, mergedCommitSha: null, mergedLanding: landing };
}

beforeEach(() => {
  shape = 'git';
  issueRow = { id: ISSUE_ID, projectId: PROJECT_ID, mergedAt: null };
  heldRow = { mergedAt: null, mergedCommitSha: null, mergedLanding: null };
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
    expect(claimed.detail).toContain('Forge did not see this merge');
    expect(claimed.detail).toContain('abc1234');
    expect(claimed.detail).toContain('so the mark is a claim that names no commit');
  });

  it('names the sha it witnessed in seven characters, so a person can read it (ISS-1421)', async () => {
    asObserved();
    const witnessed = await mark();
    expect(witnessed.detail).toContain(`commit ${OBSERVED_SHA.slice(0, 7)},`);
    expect(witnessed.detail).not.toContain(OBSERVED_SHA);
    expect(witnessed.detail).not.toContain('Forge did not see this merge');
  });

  it('calls a stamp of the empty string a claim, not a merge it witnessed', async () => {
    asAsserted('');
    expect((await mark()).mark).toBe('asserted');
  });

  it('does not tell a caller its own commit was overruled when the column holds it', async () => {
    asObserved();
    const agreeing = await mark({ target: 'main', commit: OBSERVED_SHA.toUpperCase() });
    expect(agreeing.detail).not.toContain('is not the merge commit Forge holds');
  });

  it('tells a caller that named a different commit that the column holds another', async () => {
    asObserved();
    const disagreeing = await mark({ target: 'main', commit: 'abc1234' });
    expect(disagreeing.detail).toContain('abc1234');
    expect(disagreeing.detail).toContain('named in this mark, was not recorded');
  });
});

describe('a second mark over a row that already holds a merge Forge witnessed', () => {
  /** The gated UPDATE moves nothing, so the answer describes the stamp already there. */
  function alreadyObserved() {
    projectionRows = [];
    stampedRows = [];
    heldRow = { mergedAt: AT, mergedCommitSha: OBSERVED_SHA, mergedLanding: null };
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
    expect(answer.detail).not.toContain('is not the merge commit Forge holds');
  });

  // Before round 7 this answered 200 "kept as a claim only" and left the mark at the first merge:
  // a later commit is now read as this issue's landing, and refused by name where it is not.
  it("refuses a different commit that is not this issue's landing, by the repository's own refusal", async () => {
    alreadyObserved();
    const res = await call('POST', { target: 'main', commit: 'abc1234' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('COMMIT_NOT_THIS_ISSUE');
    expect(body.message).toContain('abc1234');
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
    expect(cleared.detail).toContain('not marked merged');
  });
});

describe('a landing outside git, at the REST door (ISS-1327)', () => {
  const LANDING = 'https://mowmentbrand.com/products/linen-tee';

  it('marks a website project landed when the mark names where the work landed', async () => {
    shape = 'outside_git';
    asLanded(LANDING);
    const answer = await mark({ target: 'ISS-38', landing: LANDING });
    expect(answer.mark).toBe('landed');
    expect(answer.detail).toContain(LANDING);
  });

  it('refuses a website project a mark that names no landing, by name', async () => {
    shape = 'outside_git';
    const res = await call('POST', { target: 'ISS-38' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('LANDING_REQUIRED');
    expect(body.message).toContain('Send `landing`');
  });

  it('lets a website project mark without a landing where Forge observed the merge', async () => {
    shape = 'outside_git';
    asObserved();
    expect((await mark()).mark).toBe('observed');
  });

  it('refuses a landing on a project that lands in git, by name', async () => {
    const res = await call('POST', { target: 'main', landing: LANDING });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('LANDING_NOT_THIS_SHAPE');
  });

  it.each([
    ['blank', '   '],
    ['past 2000 characters', 'x'.repeat(2001)],
  ])('refuses a %s landing at the body schema, naming the field', async (_what, landing) => {
    shape = 'outside_git';
    const res = await call('POST', { target: 'ISS-38', landing });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('landing');
  });
});

// ISS-1421 r9, criteria 63 and 131: judge-43 read "Invalid input" and zod's "Too small: expected
// string to have >=1 characters" for a mark with no target or a blank one. Every refusal of this
// door's own input is one capitalised sentence, stopped, naming what the mark needs.
describe("the merge door's refusals of its own input (ISS-1421 r9)", () => {
  function oneSentence(message: string): void {
    expect(message).not.toBe('Invalid input');
    expect(message, message).toMatch(/^[A-Z]/);
    expect(message, message).toMatch(/\.$/);
    expect(message.split(/(?<=\.)\s+(?=[A-Z])/).length, message).toBe(1);
    expect(message.split(/\s+/).length, message).toBeLessThanOrEqual(20);
  }

  it.each([
    ['no target', {}],
    ['a blank target', { target: '' }],
    ['an all-spaces target', { target: '   ' }],
    ['a commit and no target', { commit: 'abc1234' }],
  ])('refuses %s on a git project naming `target`', async (_what, body) => {
    const res = await call('POST', body);
    expect(res.status).toBe(400);
    const answer = (await res.json()) as { code: string; message: string };
    expect(answer.code).toBe('BAD_REQUEST');
    expect(answer.message).toBe('Name the branch the work merged into as `target`.');
    oneSentence(answer.message);
  });

  it.each([
    ['a target past 200 characters', { target: 'x'.repeat(201) }, '`target`'],
    ['a blank note', { target: 'main', note: '  ' }, '`note`'],
    ['a commit that is not a sha', { target: 'main', commit: 'not-a-sha' }, '`commit`'],
    ['a blank landing', { target: 'main', landing: ' ' }, '`landing`'],
    ['a mergedAt that is not a time', { target: 'main', mergedAt: 'yesterday' }, '`mergedAt`'],
    ['a field a mark does not take', { target: 'main', branch: 'main' }, '`branch`'],
    [
      'ten fields a mark does not take',
      Object.fromEntries([
        ['target', 'main'],
        ...Array.from({ length: 10 }, (_, i) => [`k${i}`, 1]),
      ]),
      '`k0` and 9 more',
    ],
    ['a field named in a sentence', { target: 'main', 'Stop. Do this.': 1 }, 'Leave out fields,'],
  ])('refuses %s in one sentence naming the field', async (_what, body, field) => {
    const res = await call('POST', body);
    expect(res.status).toBe(400);
    const answer = (await res.json()) as { message: string };
    expect(answer.message).toContain(field);
    oneSentence(answer.message);
  });

  it('takes a blank target as no target where the project owes none', async () => {
    shape = 'outside_git';
    asLanded('https://shop.example.com/p/1');
    expect((await mark({ target: ' ', landing: 'https://shop.example.com/p/1' })).mark).toBe(
      'landed',
    );
  });
});
