/**
 * An issue names the patterns it builds to (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`):
 * a catalogued one is reuse and records no approval, an uncatalogued one is new and holds the issue
 * at every dispatch door until one reviewer holding patterns.approve, never its author, decides it;
 * and the move to awaiting_release asks an approved one for its catalog entry.
 */

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
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;
let patternReleaseRefusal: typeof import('../../src/issues/patterns.js').patternReleaseRefusal;
let catalogReadingOf: typeof import('../../src/issues/pattern-rules.js').catalogReadingOf;

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
  ({ patternReleaseRefusal } = await import('../../src/issues/patterns.js'));
  ({ catalogReadingOf } = await import('../../src/issues/pattern-rules.js'));
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

  it('asks an approved new pattern for its entry in the catalog the project reads', async () => {
    const catalog = catalogReadingOf(THIS_REPOSITORY);
    const ask = () => db.transaction((tx) => patternReleaseRefusal(tx, ids.held, catalog));
    expect((await ask())?.code).toBe('PATTERN_ENTRY_MISSING');
    const landed = { kind: 'read' as const, slugs: new Set(['webhook-door']) };
    expect(await db.transaction((tx) => patternReleaseRefusal(tx, ids.held, landed))).toBeNull();
    expect(await db.transaction((tx) => patternReleaseRefusal(tx, ids.reuse, catalog))).toBeNull();
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

describe('the table keeps a decision', () => {
  it('refuses rewriting a decided row at the database', async () => {
    const err = await db
      .execute(sql`UPDATE issue_patterns SET decision = 'returned' WHERE id = ${ids.pattern}`)
      .then(
        () => null,
        (e: { cause?: { message?: string } }) => e,
      );
    expect(err?.cause?.message).toMatch(/ISSUE_PATTERN_DECIDED_ONCE/);
    const [row] = await rows<{ decision: string }>(
      sql`SELECT decision FROM issue_patterns WHERE id = ${ids.pattern}`,
    );
    expect(row?.decision).toBe('approved');
  });
});
