/**
 * An approved new pattern's catalog page is in the issue's own change whatever order the pattern and
 * the merge meet in (REQ-36 BC-3; Issue lifecycle r14 `design-check`, Issue to release r20
 * `rule-merge`). The judge at 9988a9335 (comment 1000c87f) found the page asked once, over the
 * patterns approved at that moment, so two orders reached awaiting_release with no page anywhere:
 * (a) named while pending, the merge marked without the page, then approved; (b) the merge marked
 * first, then named and approved. A third has the merge check run while the pattern waited.
 *
 * The page is now asked again against the change the merge mark names: at an approval on an issue
 * already marked, and at the move to awaiting_release. The repository is read through a source host
 * this suite stands in for, so its answers (a page held, a page missing, a commit it does not know,
 * a failure, an answer that is neither) are each shown.
 *
 * @direct-test-of packages/core/src/issues/pattern-entry.ts
 * @direct-test-of packages/core/src/issues/transition-guards.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { passingReport } from '../helpers/merge-check-report.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** What the stand-in host answers for `<ref>:<path>`; anything unset is missing at that ref. */
const host = vi.hoisted(() => ({
  answers: new Map<string, unknown>(),
  reads: [] as string[],
}));

vi.mock('../../src/integrations/source-host/index.js', async (original) => ({
  ...(await original<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => ({
    fullName: 'SidCorp-co/forge',
    provider: 'github',
    readCommit: async () => null,
    branchContains: async () => false,
    readFile: async (path: string, ref: string) => {
      host.reads.push(`${ref}:${path}`);
      const answer = host.answers.get(`${ref}:${path}`);
      if (answer instanceof Error) throw answer;
      return answer ?? { missing: `${path} does not exist at ${ref}` };
    },
  }),
}));

const tokens = { reviewer: '', author: '' };
let reviewerId = '';
let forge = '';
let seq = 0;

const SHA = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const CODE = { path: 'packages/core/src/queue/door.ts', change: 'added' as const };

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const reviewer = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  reviewerId = reviewer.id;
  const { id } = await createTestProject(reviewer.id);
  await seedProjectDocument(id, reviewer.id, {
    environments: {
      dev: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
    source: {
      type: 'git',
      git: { repository: THIS_REPOSITORY, defaultBranch: 'main', branches: ['main'] },
    },
  });
  forge = id;
  await addProjectMember(forge, reviewer.id, 'admin');
  await addProjectMember(forge, author.id, 'member');
  tokens.reviewer = await userToken(reviewer.id);
  tokens.author = await userToken(author.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(() => {
  host.answers.clear();
  host.reads.length = 0;
});

async function call(
  who: keyof typeof tokens,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
const detail = (res: { body: Doc }): string => res.body.error?.refusals?.[0]?.detail ?? '';

async function inProgress(): Promise<string> {
  seq += 1;
  return (
    await createTestIssue(forge, reviewerId, 9000 + seq, {
      status: 'in_progress',
      createdAt: new Date(),
    })
  ).id;
}

const slugOf = (issue: string) => `door-${issue.slice(0, 8)}`;
const pageOf = (issue: string) => `docs/patterns/${slugOf(issue)}.md`;

/** The author names the issue's own new pattern; it waits on one reviewer. */
async function named(issue: string): Promise<string> {
  const made = ok(
    await call('author', 'POST', `/api/issues/${issue}/patterns`, {
      pattern: slugOf(issue),
      summary: 'a queue consumer as a door; no catalogued pattern consumes a queue',
    }),
    201,
  );
  return made.pattern.id as string;
}

const approve = (issue: string, patternId: string) =>
  call('reviewer', 'POST', `/api/issues/${issue}/patterns/${patternId}/decision`, {
    decision: 'approved',
    reason: 'nothing catalogued consumes a queue',
  });

/** A merge mark at SHA, with the files the box read it changed where `changes` is given. */
const mark = (issue: string, changes?: { path: string; change: 'added' | 'changed' }[]) =>
  call('reviewer', 'POST', `/api/issues/${issue}/merge`, {
    target: 'main',
    commit: SHA,
    note: 'landed',
    ...(changes ? { changedPaths: { commit: SHA, changes } } : {}),
  });

const unmark = (issue: string) =>
  call('reviewer', 'DELETE', `/api/issues/${issue}/merge`, { note: 'the page lands' });

const checked = (issue: string, touched: { path: string; change: 'added' | 'changed' }[]) =>
  call(
    'reviewer',
    'POST',
    `/api/issues/${issue}/merge-check`,
    passingReport({ base: { branch: 'main', sha: BASE }, head: SHA, touched }),
  );

/** One criterion judged passing at the marked commit: all the move asks besides the patterns. */
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

const statusOf = async (issue: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issue}`))[0]?.status;

const decisionOf = async (patternId: string) =>
  (
    await rows<{ decision: string | null }>(
      sql`SELECT decision FROM issue_patterns WHERE id = ${patternId}`,
    )
  )[0]?.decision ?? null;

/** An approval written past the route, as one made before the route asked: the move is the backstop. */
async function approvedPastTheRoute(patternId: string): Promise<void> {
  await db.execute(
    sql`UPDATE issue_patterns SET decision = 'approved', decided_by = ${reviewerId}, decided_at = now(), decision_reason = 'approved before the approval asked for the page' WHERE id = ${patternId}`,
  );
}

describe('order (a): named while pending, the merge marked without the page, then approved', () => {
  it('refuses the approval while the marked change holds no page, saying what was read; once the page is in the marked change it is approved and the issue moves', async () => {
    const issue = await inProgress();
    const pattern = await named(issue);
    ok(await mark(issue, [CODE]));
    const refused = await approve(issue, pattern);
    expect([refused.status, codes(refused)]).toEqual([422, ['PATTERN_ENTRY_MISSING']]);
    expect(detail(refused)).toContain(pageOf(issue));
    expect(detail(refused)).toContain(
      `the paths the box read at ${SHA} when the merge was marked list none`,
    );
    expect(detail(refused)).toContain(`${pageOf(issue)} does not exist at ${SHA}`);
    expect(detail(refused)).toContain('Nothing was decided');
    expect(await decisionOf(pattern)).toBeNull();

    ok(await unmark(issue));
    ok(await mark(issue, [CODE, { path: pageOf(issue), change: 'added' }]));
    ok(await approve(issue, pattern));
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, codes(moved)]).toEqual([200, []]);
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('is refused at the move to awaiting_release where the approval stood without the page, and the issue stays', async () => {
    const issue = await inProgress();
    const pattern = await named(issue);
    ok(await mark(issue, [CODE]));
    await approvedPastTheRoute(pattern);
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, codes(moved)]).toEqual([422, ['PATTERN_ENTRY_MISSING']]);
    expect(detail(moved)).toContain(`\`${slugOf(issue)}\``);
    expect(detail(moved)).toContain("the change this issue's merge mark names");
    expect(detail(moved)).toContain(`no merge check passing at ${SHA} is recorded`);
    expect(detail(moved)).toContain('The issue did not move');
    expect(await statusOf(issue)).toBe('in_progress');
  });
});

describe('order (b): the merge marked first, then named and approved', () => {
  it('refuses the approval, and the move where an approval stood; the page the repository holds at the marked commit lets it move', async () => {
    const issue = await inProgress();
    ok(await mark(issue));
    const pattern = await named(issue);
    const refused = await approve(issue, pattern);
    expect([refused.status, codes(refused)]).toEqual([422, ['PATTERN_ENTRY_MISSING']]);
    expect(detail(refused)).toContain(`the mark carries no paths the box read at ${SHA}`);

    await approvedPastTheRoute(pattern);
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, codes(moved)]).toEqual([422, ['PATTERN_ENTRY_MISSING']]);
    expect(await statusOf(issue)).toBe('in_progress');

    host.answers.set(`${SHA}:${pageOf(issue)}`, '# Door\n');
    const again = await toAwaitingRelease(issue);
    expect([again.status, codes(again)]).toEqual([200, []]);
    expect(host.reads).toContain(`${SHA}:${pageOf(issue)}`);
  });
});

describe('a merge check run while the pattern waited', () => {
  it('passes then, the mark takes it once approved, and the move refuses the page that change did not carry', async () => {
    const issue = await inProgress();
    const pattern = await named(issue);
    expect((await checked(issue, [CODE])).status).toBe(201);
    ok(await approve(issue, pattern));
    ok(await mark(issue));
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, codes(moved)]).toEqual([422, ['PATTERN_ENTRY_MISSING']]);
    expect(detail(moved)).toContain(`the merge check passing at ${SHA} recorded none`);
  });

  it('records the catalog page its change carried, which the move reads with no repository', async () => {
    const issue = await inProgress();
    const pattern = await named(issue);
    const page = { path: pageOf(issue), change: 'added' as const };
    expect((await checked(issue, [CODE, page])).status).toBe(201);
    ok(await approve(issue, pattern));
    ok(await mark(issue));
    await judged(issue);
    host.answers.set(`${SHA}:${pageOf(issue)}`, new Error('the repository must not be read here'));
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, codes(moved)]).toEqual([200, []]);
    expect(host.reads).toEqual([]);
  });
});

describe("the repository's answers, where only it can show the page", () => {
  async function markedWithoutPage(): Promise<string> {
    const issue = await inProgress();
    const pattern = await named(issue);
    ok(await mark(issue));
    await approvedPastTheRoute(pattern);
    await judged(issue);
    return issue;
  }

  it("gives a commit the host does not know, in the host's own words", async () => {
    const issue = await markedWithoutPage();
    host.answers.set(`${SHA}:${pageOf(issue)}`, { missing: `No commit found for the ref ${SHA}` });
    const moved = await toAwaitingRelease(issue);
    expect(codes(moved)).toEqual(['PATTERN_ENTRY_MISSING']);
    expect(detail(moved)).toContain(
      `the repository at ${SHA} holds none (No commit found for the ref ${SHA})`,
    );
  });

  it('gives a host that fails, and never counts the page', async () => {
    const issue = await markedWithoutPage();
    host.answers.set(`${SHA}:${pageOf(issue)}`, new Error('GitHub answered 502'));
    const moved = await toAwaitingRelease(issue);
    expect(codes(moved)).toEqual(['PATTERN_ENTRY_MISSING']);
    expect(detail(moved)).toContain('the repository could not be read (GitHub answered 502)');
  });

  it('never counts an answer that is neither the text nor a reason', async () => {
    const issue = await markedWithoutPage();
    host.answers.set(`${SHA}:${pageOf(issue)}`, { size: 12 });
    const moved = await toAwaitingRelease(issue);
    expect(codes(moved)).toEqual(['PATTERN_ENTRY_MISSING']);
    expect(detail(moved)).toContain('the host answered neither its text nor why');
  });

  it('never reads the running build: a slug the build catalogues, approved as new, still needs its page in the change', async () => {
    const issue = await inProgress();
    ok(await mark(issue));
    await db.execute(
      sql`INSERT INTO issue_patterns (project_id, issue_id, pattern, kind, summary, named_by, decision, decided_by, decided_at, decision_reason)
          VALUES (${forge}, ${issue}, 'api-route', 'new', 'named before the catalog held it', ${reviewerId}, 'approved', ${reviewerId}, now(), 'approved')`,
    );
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect(codes(moved)).toEqual(['PATTERN_ENTRY_MISSING']);
    expect(detail(moved)).toContain('docs/patterns/api-route.md');
  });
});

describe('a reading the mark has moved past', () => {
  it('is refused under the lock rather than passed on the change it no longer names', async () => {
    const { readMoveEntryFacts, moveEntryRefusal } = await import(
      '../../src/issues/pattern-entry.js'
    );
    const issue = await inProgress();
    const pattern = await named(issue);
    ok(await mark(issue, [CODE, { path: pageOf(issue), change: 'added' }]));
    ok(await approve(issue, pattern));
    const facts = await readMoveEntryFacts({ id: issue, projectId: forge });
    expect(await moveEntryRefusal(db, issue, facts)).toBeNull();
    ok(await unmark(issue));
    const other = 'd'.repeat(40);
    const report = passingReport({
      base: { branch: 'main', sha: BASE },
      head: other,
      touched: [CODE, { path: pageOf(issue), change: 'added' }],
    });
    ok(await call('reviewer', 'POST', `/api/issues/${issue}/merge-check`, report), 201);
    ok(
      await call('reviewer', 'POST', `/api/issues/${issue}/merge`, {
        target: 'main',
        commit: other,
        note: 'landed again',
      }),
    );
    const stale = await moveEntryRefusal(db, issue, facts);
    expect(stale?.code).toBe('PATTERN_ENTRY_MISSING');
    expect(stale?.detail).toContain(`read at ${SHA}, marked now at ${other}`);
  });
});

describe('an issue with no approved new pattern', () => {
  it('moves with no PATTERN_* refusal and no read of the repository', async () => {
    const issue = await inProgress();
    ok(
      await call('author', 'POST', `/api/issues/${issue}/patterns`, { pattern: 'api-route' }),
      201,
    );
    ok(await mark(issue));
    await judged(issue);
    const moved = await toAwaitingRelease(issue);
    expect([moved.status, codes(moved)]).toEqual([200, []]);
    expect(host.reads).toEqual([]);
  });
});
