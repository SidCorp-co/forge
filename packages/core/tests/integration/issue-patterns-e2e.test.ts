/**
 * An issue names the patterns it builds to (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`,
 * Issue to release r20 `rule-merge`): a catalogued one is reuse and records no approval, an
 * uncatalogued one is new and holds the issue until one reviewer holding patterns.approve, never its
 * author, decides it. A return is posted on the issue and holds the work until the issue answers it.
 * An approved one's catalog page is asked for by the merge check, which reads the change, and the
 * mark asks for a passing check, so the issue that introduces it reaches awaiting_release. The
 * dispatch doors and the run author rule are `issue-pattern-doors-e2e.test.ts`.
 *
 * @direct-test-of packages/core/src/issues/pattern-entry.ts
 * @direct-test-of packages/core/src/issues/pattern-routes.ts
 * @direct-test-of packages/core/src/issues/patterns.ts
 */

import { REQUIRED_MERGE_CHECKS } from '@forge/contracts/merge-check';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;

const tokens = { reviewer: '', author: '', viewer: '' };
let reviewerId = '';
let forge = '';
let other = '';
let box = '';
let seq = 0;

const environments = {
  dev: {
    tier: 'production' as const,
    deploysFrom: 'main',
    deployment: { mode: 'external' as const },
  },
};

async function projectBuiltFrom(ownerId: string, repository: string): Promise<string> {
  const { id } = await createTestProject(ownerId);
  await seedProjectDocument(id, ownerId, {
    environments,
    source: { type: 'git', git: { repository, defaultBranch: 'main', branches: ['main'] } },
  });
  return id;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ readAdmissibleIssues } = await import('../../src/devices/admissible.js'));
  const reviewer = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  const viewer = await createTestUser({ verified: true });
  reviewerId = reviewer.id;
  forge = await projectBuiltFrom(reviewer.id, THIS_REPOSITORY);
  other = await projectBuiltFrom(reviewer.id, 'github.com/acme/shop');
  for (const p of [forge, other]) {
    await addProjectMember(p, reviewer.id, 'admin');
    await addProjectMember(p, author.id, 'member');
    await addProjectMember(p, viewer.id, 'viewer');
  }
  box = await createTestDevice(reviewer.id);
  await bindTestRunner(forge, box);
  tokens.reviewer = await userToken(reviewer.id);
  tokens.author = await userToken(author.id);
  tokens.viewer = await userToken(viewer.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function issueAt(projectId: string, status: string): Promise<string> {
  seq += 1;
  return (await createTestIssue(projectId, reviewerId, seq, { status, createdAt: new Date() })).id;
}

async function call(
  who: keyof typeof tokens,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Doc }> {
  const res = await api(tokens[who], method, path, body);
  return { status: res.status, body: res.body as Doc };
}

function ok(res: { status: number; body: Doc }, status = 200): Doc {
  expect([res.status, res.body]).toEqual([status, expect.anything()]);
  return res.body;
}

function refused(res: { status: number; body: Doc }): string[] {
  return (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
}

const patterns = (issue: string) => `/api/issues/${issue}/patterns`;
const admitted = async () =>
  (await readAdmissibleIssues({ deviceId: box, projectId: forge })).items.map((a) => a.issueId);

const SHA = 'c'.repeat(40);

/** The merge stamped as a repository would have, for a case whose subject is past the mark. */
async function landedAt(issue: string): Promise<void> {
  await db.execute(
    sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${SHA} WHERE id = ${issue}`,
  );
}

/** One criterion, judged passing at the landed commit: all the move to awaiting_release asks besides. */
async function judged(issue: string): Promise<void> {
  ok(
    await call('reviewer', 'PATCH', `/api/issues/${issue}`, { acceptanceCriteria: '1. It holds.' }),
  );
  ok(
    await call('reviewer', 'POST', `/api/issues/${issue}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'shown',
      identity: { kind: 'commit', sha: SHA },
    }),
    201,
  );
}

const toAwaitingRelease = (issue: string) =>
  call('reviewer', 'POST', `/api/issues/${issue}/transition`, { toStatus: 'awaiting_release' });

/** A mark naming the landed commit, with the files the box read it changed. */
const mark = (
  issue: string,
  changes: { path: string; change: 'added' | 'changed' | 'removed' }[],
) =>
  call('reviewer', 'POST', `/api/issues/${issue}/merge`, {
    target: 'main',
    commit: SHA,
    note: 'landed',
    changedPaths: { commit: SHA, changes },
  });

const RAN = { scope: 'workspace', command: 'ran', files: [], result: 'pass', durationMs: 1 };

/** The merge check's report at the landed commit, over the files the change touches. */
const checked = (issue: string, touched: Parameters<typeof mark>[1]) =>
  call('reviewer', 'POST', `/api/issues/${issue}/merge-check`, {
    base: { branch: 'main', sha: 'b'.repeat(40) },
    head: SHA,
    mode: 'pre-merge',
    touched,
    checks: REQUIRED_MERGE_CHECKS.map((name) => ({ name, ...RAN })),
  });

const statusOf = async (issue: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issue}`))[0]?.status;

const ids = { reuse: '', held: '', pattern: '' };

describe('reusing a catalogued pattern', () => {
  it('records it as reuse, holds nothing, and has nothing for a reviewer to decide', async () => {
    ids.reuse = await issueAt(forge, 'open');
    const made = ok(
      await call('author', 'POST', patterns(ids.reuse), { pattern: 'api-route' }),
      201,
    );
    expect(made.pattern).toMatchObject({
      pattern: 'api-route',
      kind: 'reuse',
      decision: null,
      pending: false,
    });
    const read = ok(await call('author', 'GET', patterns(ids.reuse)));
    expect(read).toMatchObject({ dispatchable: true, refusal: null });
    expect(await admitted()).toContain(ids.reuse);
    const decided = await call(
      'reviewer',
      'POST',
      `${patterns(ids.reuse)}/${made.pattern.id}/decision`,
      {
        decision: 'approved',
        reason: 'fine',
      },
    );
    expect(refused(decided)).toEqual(['PATTERN_NOT_NEW']);
  });
});

describe('naming a pattern the catalog does not hold', () => {
  it('refuses it without the summary its reviewer reads, writing nothing', async () => {
    ids.held = await issueAt(forge, 'open');
    expect(
      refused(await call('author', 'POST', patterns(ids.held), { pattern: 'webhook-door' })),
    ).toEqual(['PATTERN_SUMMARY_REQUIRED']);
    expect(ok(await call('author', 'GET', patterns(ids.held))).patterns).toEqual([]);
  });

  it('records it as new and pending, and the issue read names the hold', async () => {
    const made = ok(
      await call('author', 'POST', patterns(ids.held), {
        pattern: 'webhook-door',
        summary:
          'An inbound webhook as a door of its own; no catalogued pattern takes vendor traffic in',
      }),
      201,
    );
    expect(made.pattern).toMatchObject({ kind: 'new', pending: true, decision: null });
    ids.pattern = made.pattern.id;
    const read = ok(await call('author', 'GET', patterns(ids.held)));
    expect(read.dispatchable).toBe(false);
    expect(read.refusal.code).toBe('PATTERN_REVIEW_PENDING');
    expect(read.refusal.detail).toContain('`webhook-door`');
    const detail = ok(await call('author', 'GET', `/api/issues/${ids.held}`));
    expect(detail.patterns.dispatchable).toBe(false);
  });

  it('is held at every dispatch door: the admissible list, the issue list, and the move to in_progress', async () => {
    expect(await admitted()).not.toContain(ids.held);
    const list = ok(await call('author', 'GET', `/api/projects/${forge}/issues?limit=100`));
    const row = (list.items ?? list.issues ?? list.data).find((r: Doc) => r.id === ids.held);
    expect(row.withheld.code).toBe('PATTERN_REVIEW_PENDING');
    const move = await call('reviewer', 'POST', `/api/issues/${ids.held}/transition`, {
      toStatus: 'in_progress',
    });
    expect(refused(move)).toContain('PATTERN_REVIEW_PENDING');
  });

  it('refuses a second naming of the same live slug, and a viewer naming one', async () => {
    expect(
      refused(
        await call('author', 'POST', patterns(ids.held), {
          pattern: 'webhook-door',
          summary: 'again',
        }),
      ),
    ).toEqual(['PATTERN_ALREADY_NAMED']);
    const viewer = await call('viewer', 'POST', patterns(ids.held), { pattern: 'api-route' });
    expect([viewer.status, viewer.body.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
  });
});

describe('one reviewer decides a new pattern', () => {
  it('refuses a member without patterns.approve', async () => {
    const res = await call('author', 'POST', `${patterns(ids.held)}/${ids.pattern}/decision`, {
      decision: 'approved',
      reason: 'mine',
    });
    expect([res.status, res.body.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
  });

  it('refuses the account that named it, even holding patterns.approve', async () => {
    const issue = await issueAt(forge, 'open');
    const own = ok(
      await call('reviewer', 'POST', patterns(issue), {
        pattern: 'queue-door',
        summary: 'a queue as a door',
      }),
      201,
    );
    const res = await call('reviewer', 'POST', `${patterns(issue)}/${own.pattern.id}/decision`, {
      decision: 'approved',
      reason: 'self',
    });
    expect(refused(res)).toEqual(['PATTERN_REVIEWER_IS_AUTHOR']);
  });

  it('records the approval with who, when and why, once, and the issue is released', async () => {
    const res = ok(
      await call('reviewer', 'POST', `${patterns(ids.held)}/${ids.pattern}/decision`, {
        decision: 'approved',
        reason: 'no catalogued door takes vendor traffic in',
      }),
    );
    expect(res.pattern).toMatchObject({
      decision: 'approved',
      decidedBy: reviewerId,
      decisionReason: 'no catalogued door takes vendor traffic in',
      pending: false,
    });
    expect(Date.parse(res.pattern.decidedAt)).not.toBeNaN();
    const again = await call('reviewer', 'POST', `${patterns(ids.held)}/${ids.pattern}/decision`, {
      decision: 'returned',
      reason: 'changed my mind',
    });
    expect([again.status, refused(again)]).toEqual([409, ['PATTERN_ALREADY_DECIDED']]);
    expect(ok(await call('author', 'GET', patterns(ids.held))).dispatchable).toBe(true);
    expect(await admitted()).toContain(ids.held);
  });
});

describe('the work it holds and the merge it asks of', () => {
  it('holds the work step out of build while the review is pending, and not before it', async () => {
    const issue = await issueAt(forge, 'in_progress');
    ok(
      await call('author', 'POST', patterns(issue), {
        pattern: 'cron-door',
        summary: 'a timer as a door',
      }),
      201,
    );
    const build = await call('author', 'PATCH', `/api/issues/${issue}`, {
      workState: { step: 'build' },
    });
    expect(refused(build)).toEqual(['PATTERN_REVIEW_PENDING']);
    ok(await call('author', 'PATCH', `/api/issues/${issue}`, { workState: { step: 'plan' } }));
  });

  it('refuses the move to awaiting_release while a review waits, through the route', async () => {
    const issue = await issueAt(forge, 'in_progress');
    await landedAt(issue);
    ok(
      await call('author', 'POST', patterns(issue), {
        pattern: 'queue-door',
        summary: 'a queue consumer as a door',
      }),
      201,
    );
    const pending = await toAwaitingRelease(issue);
    expect([pending.status, refused(pending)]).toEqual([422, ['PATTERN_REVIEW_PENDING']]);
  });

  it('a retracted pending pattern stops holding its issue, and is retracted once', async () => {
    const issue = await issueAt(forge, 'open');
    const made = ok(
      await call('author', 'POST', patterns(issue), {
        pattern: 'mail-door',
        summary: 'mail as a door',
      }),
      201,
    );
    expect(await admitted()).not.toContain(issue);
    const path = `${patterns(issue)}/${made.pattern.id}/retract`;
    ok(await call('author', 'POST', path, { reason: 'the api-route pattern serves it' }));
    expect(await admitted()).toContain(issue);
    expect(refused(await call('author', 'POST', path, { reason: 'twice' }))).toEqual([
      'PATTERN_RETRACTED',
    ]);
  });
});

describe('a project whose catalog Forge cannot read', () => {
  it('refuses naming any pattern there, by name', async () => {
    const issue = await issueAt(other, 'open');
    const res = await call('author', 'POST', patterns(issue), { pattern: 'api-route' });
    expect(refused(res)).toEqual(['PATTERN_CATALOG_UNDECLARED']);
  });
});

describe('the issue that introduces a pattern reaches awaiting_release (BC-3)', () => {
  const page = 'docs/patterns/queue-door.md';
  let issue = '';

  it('is refused at the merge check while the change it reads holds no page for the approved pattern', async () => {
    issue = await issueAt(forge, 'in_progress');
    const made = ok(
      await call('author', 'POST', patterns(issue), {
        pattern: 'queue-door',
        summary: 'a queue consumer as a door; no catalogued pattern consumes a queue',
      }),
      201,
    );
    ok(
      await call('reviewer', 'POST', `${patterns(issue)}/${made.pattern.id}/decision`, {
        decision: 'approved',
        reason: 'nothing catalogued consumes a queue',
      }),
    );
    const without = await checked(issue, [
      { path: 'packages/core/src/queue/door.ts', change: 'added' },
    ]);
    expect([without.status, refused(without)]).toEqual([422, ['PATTERN_ENTRY_MISSING']]);
    expect(without.body.error.refusals[0].detail).toContain(page);
    expect(without.body.error.refusals[0].detail).toContain(
      `the files the change touches at ${SHA} list none`,
    );
    const removed = await checked(issue, [{ path: page, change: 'removed' }]);
    expect(refused(removed)).toEqual(['PATTERN_ENTRY_MISSING']);
  });

  it('is refused at the mark while no passing merge check stands, the mark no longer reading the page itself', async () => {
    const res = await mark(issue, [
      { path: 'packages/core/src/queue/door.ts', change: 'added' },
      { path: page, change: 'added' },
    ]);
    expect([res.status, refused(res)]).toEqual([422, ['MERGE_CHECK_MISSING']]);
    expect(res.body.error.refusals[0].detail).toContain('introduces an approved new pattern');
    expect(await statusOf(issue)).toBe('in_progress');
  });

  it('is marked once a check over the page passed, and moves to awaiting_release with no PATTERN_* refusal', async () => {
    const touched = [
      { path: 'packages/core/src/queue/door.ts', change: 'added' as const },
      { path: page, change: 'added' as const },
    ];
    expect((await checked(issue, touched)).status).toBe(201);
    const marked = ok(await mark(issue, touched));
    expect(marked.action).toBe('merged');
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, refused(moved)]).toEqual([200, []]);
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('asks nothing of an issue whose patterns are all reuse', async () => {
    const reuse = await issueAt(forge, 'in_progress');
    ok(await call('author', 'POST', patterns(reuse), { pattern: 'api-route' }), 201);
    ok(await mark(reuse, [{ path: 'packages/core/src/x/routes.ts', change: 'changed' }]));
  });
});

describe('a returned pattern holds the work until the issue answers it', () => {
  let issue = '';
  let returned = '';

  it('posts the reason on the issue and leaves the issue dispatchable', async () => {
    issue = await issueAt(forge, 'open');
    const made = ok(
      await call('author', 'POST', patterns(issue), {
        pattern: 'cache-door',
        summary: 'a cache as a door',
      }),
      201,
    );
    returned = made.pattern.id;
    ok(
      await call('reviewer', 'POST', `${patterns(issue)}/${returned}/decision`, {
        decision: 'returned',
        reason: 'the api-route pattern already serves a cached read',
      }),
    );
    const comments = ok(await call('author', 'GET', `/api/issues/${issue}/comments`));
    const bodies: string[] = (comments.items ?? comments.comments ?? comments).map(
      (c: Doc) => c.body,
    );
    expect(
      bodies.some(
        (b) => b.includes('`cache-door`') && b.includes('the api-route pattern already serves'),
      ),
    ).toBe(true);
    const read = ok(await call('author', 'GET', patterns(issue)));
    expect(read.dispatchable).toBe(true);
    expect(read.returned.code).toBe('PATTERN_RETURNED');
    expect(read.patterns[0]).toMatchObject({ decision: 'returned', unanswered: true });
    expect(await admitted()).toContain(issue);
  });

  it('holds the work step out of build and the issue out of awaiting_release, and refuses retracting it', async () => {
    await seedIssueStatus(issue, 'in_progress');
    const build = await call('author', 'PATCH', `/api/issues/${issue}`, {
      workState: { step: 'build' },
    });
    expect(refused(build)).toEqual(['PATTERN_RETURNED']);
    await landedAt(issue);
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, refused(moved)]).toEqual([422, ['PATTERN_RETURNED']]);
    const retract = await call('author', 'POST', `${patterns(issue)}/${returned}/retract`, {
      reason: 'never mind',
    });
    expect(refused(retract)).toEqual(['PATTERN_RETURNED']);
  });

  it('is answered by naming a catalogued pattern, after which build and awaiting_release are open', async () => {
    ok(await call('author', 'POST', patterns(issue), { pattern: 'api-route' }), 201);
    const read = ok(await call('author', 'GET', patterns(issue)));
    expect(read.returned).toBeNull();
    ok(await call('author', 'PATCH', `/api/issues/${issue}`, { workState: { step: 'build' } }));
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, refused(moved)]).toEqual([200, []]);
  });

  it('is answered by naming the slug again revised, which waits on a new review', async () => {
    const other = await issueAt(forge, 'open');
    const made = ok(
      await call('author', 'POST', patterns(other), { pattern: 'mail-door', summary: 'mail' }),
      201,
    );
    ok(
      await call('reviewer', 'POST', `${patterns(other)}/${made.pattern.id}/decision`, {
        decision: 'returned',
        reason: 'say what it takes in',
      }),
    );
    ok(
      await call('author', 'POST', patterns(other), {
        pattern: 'mail-door',
        summary: 'inbound mail as a door: what it takes in and why no route serves it',
      }),
      201,
    );
    const read = ok(await call('author', 'GET', patterns(other)));
    expect(read.returned).toBeNull();
    expect(read.dispatchable).toBe(false);
    expect(read.refusal.code).toBe('PATTERN_REVIEW_PENDING');
  });
});
