/**
 * ISS-919 (FB-483, owner 2026-11-03: every status check is a question in chat). A person's home reads,
 * across every project they read and none they do not: the feedback they gave and the issues they own
 * that are not live, each at its stage; each project's latest release with how many of their items it
 * carried; and a search that says where any item stands, live since a version or still moving.
 * ISS-924: what the person owes is their Needs you alone (`/api/me/attention`), a triage they hold
 * among it, so the home has no `waiting` of its own and loses no owed row. ISS-926: an issue's act is
 * on a person's Needs you only where it names them and they hold what it asks; a read-only member reads
 * it as waiting on the writers, and their /attention counts none of it. Against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/standing.ts
 * @direct-test-of packages/core/src/issues/standing-read.ts
 * @direct-test-of packages/core/src/issues/standing-viewer-read.ts
 * @direct-test-of packages/core/src/product-progress/home-routes.ts
 * @direct-test-of packages/core/src/product-progress/home-moving.ts
 * @direct-test-of packages/core/src/product-progress/home-live.ts
 * @direct-test-of packages/core/src/product-progress/home-find.ts
 * @direct-test-of packages/core/src/product-progress/home-stage.ts
 * @direct-test-of packages/core/src/lib/standing-times.ts
 * @direct-test-of packages/core/src/me/attention-routes.ts
 * @direct-test-of packages/core/src/development/needs-you-viewer.ts
 * @direct-test-of packages/core/src/development/needs-you-decisions.ts
 */

import { randomUUID } from 'node:crypto';
import { HOME_FIND_LIMIT, HOME_IDLE_DAYS, HOME_MOVING_LIMIT } from '@forge/contracts/owner-home';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let say: ReturnType<typeof requester>;
let owner = '';
let outsider = '';
let busy = '';
let projectId = '';
let slug = '';
let hiddenId = '';
const T = (day: number) => new Date(Date.UTC(2026, 9, day));
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

async function movedAt(issueId: string, at: Date) {
  await db.execute(sql`UPDATE issues SET updated_at = ${at.toISOString()} WHERE id = ${issueId}`);
}

/** A release batch that shipped `issueIds` as `version` at `at`, as the release list reads one. */
async function shippedRelease(project: string, version: string, issueIds: string[], at: Date) {
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (${randomUUID()}, ${project}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()},
            ${version}, ${at.toISOString()}, ${JSON.stringify({ source: 'release-batch', issueIds })}::jsonb)
  `);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  owner = (await createTestUser({ verified: true })).id;
  outsider = (await createTestUser({ verified: true })).id;
  busy = (await createTestUser({ verified: true })).id;
  say = requester(app, {
    owner: await signUserToken(owner),
    outsider: await signUserToken(outsider),
    busy: await signUserToken(busy),
  });
  ({ id: projectId, slug } = await createTestProject(owner));
  // a project the owner cannot read: its items and releases never reach the owner's home
  hiddenId = (await createTestProject(outsider)).id;

  const shipped = await createTestIssue(projectId, owner, 1, {
    status: 'closed',
    createdAt: T(1),
    mergedAt: T(2),
  });
  const building = await createTestIssue(projectId, owner, 2, {
    status: 'in_progress',
    createdAt: T(3),
  });
  const landed = await createTestIssue(projectId, owner, 3, {
    status: 'awaiting_release',
    createdAt: T(3),
    mergedAt: T(4),
  });
  const parked = await createTestIssue(projectId, owner, 4, { status: 'open', createdAt: T(3) });
  // last moves: ISS-6 (held, filed by someone else) an hour ago, ISS-3 two, ISS-2 a day; ISS-4 not
  // since the 3rd, so it is idle and ranks last
  const held = await createTestIssue(projectId, outsider, 6, { status: 'open', createdAt: T(3) });
  await db.execute(sql`UPDATE issues SET assignee_id = ${owner} WHERE id = ${held.id}`);
  await movedAt(held.id, hoursAgo(1));
  await movedAt(landed.id, hoursAgo(2));
  await movedAt(building.id, hoursAgo(24));
  await movedAt(parked.id, T(3));
  await createTestIssue(projectId, owner, 5, { status: 'dropped', createdAt: T(3) });
  await shippedRelease(projectId, '1.2.0', [shipped.id], T(5));
  await createTestFeedback(projectId, owner, 1);
  const hiddenIssue = await createTestIssue(hiddenId, outsider, 1, {
    status: 'closed',
    createdAt: T(1),
    mergedAt: T(2),
  });
  await shippedRelease(hiddenId, '9.9.9', [hiddenIssue.id], T(6));
  await createTestIssue(hiddenId, outsider, 2, { status: 'open', createdAt: T(3) });
  // more moving items than Moving holds
  const busyId = (await createTestProject(busy)).id;
  for (let seq = 1; seq <= HOME_MOVING_LIMIT + 2; seq++) {
    await createTestIssue(busyId, busy, seq, { status: 'in_progress', createdAt: T(3) });
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a person's home", () => {
  it('lists what the person gave and owns that is not live, each at its stage, and no date it does not hold', async () => {
    const home = ok(await say('owner', 'GET', '/api/me/home'));
    const moving = home.moving as Doc[];
    const stageOf = (key: string) => moving.find((m) => m.key === key)?.stage ?? null;
    expect(stageOf('ISS-2')).toBe('building');
    expect(stageOf('ISS-3')).toBe('landed');
    expect(stageOf('ISS-4')).toBe('planned');
    expect(stageOf('ISS-6')).toBe('planned');
    // closed and dropped are over: not moving
    expect(stageOf('ISS-1')).toBeNull();
    expect(stageOf('ISS-5')).toBeNull();
    // nothing of the project the owner cannot read
    expect(new Set(moving.map((m) => m.projectSlug))).toEqual(new Set([slug]));
    expect(moving.filter((m) => m.kind === 'issue')).toHaveLength(4);
    // a row with no forecast holds no date: null, never a guess
    for (const m of moving)
      expect(m.likelyBy === null || typeof m.likelyBy === 'string').toBe(true);
    expect(moving.find((m) => m.key === 'ISS-4')?.likelyBy).toBeNull();
  });

  it('says how many moving items there are and whether the list was cut', async () => {
    const mine = ok(await say('owner', 'GET', '/api/me/home'));
    expect(mine).toMatchObject({
      movingTotal: (mine.moving as Doc[]).length,
      movingTruncated: false,
    });
    const full = ok(await say('busy', 'GET', '/api/me/home'));
    expect(full.moving as Doc[]).toHaveLength(HOME_MOVING_LIMIT);
    expect(full).toMatchObject({ movingTotal: HOME_MOVING_LIMIT + 2, movingTruncated: true });
  });

  it('lists an item the viewer owes on their Needs you, never under moving, and the home has no waiting of its own', async () => {
    const home = ok(await say('owner', 'GET', '/api/me/home'));
    // FB-1 is new and the owner holds triage, so its standing names the owner: theirs to take
    expect((home.moving as Doc[]).map((m) => m.key)).not.toContain('FB-1');
    expect(home).not.toHaveProperty('waiting');
    // no row in moving is the viewer's
    for (const m of home.moving as Doc[]) expect(m.owes?.who).not.toBe('You');
    // the feedback list and every needs-you read agree: the triage is the owner's
    const list = ok(await say('owner', 'GET', `/api/projects/${projectId}/feedback`));
    const fb1 = (list.feedback as Doc[]).find((f) => f.key === 'FB-1');
    expect(fb1).toMatchObject({
      attentionGroup: 'needs_you',
      waitingOn: { kind: 'you', act: 'triage it' },
    });
    const attention = ok(await say('owner', 'GET', '/api/me/attention'));
    const part = (attention.needsYou as Doc[]).find((p) => p.projectSlug === slug);
    expect(part?.owed).toEqual([
      {
        reason: 'triage',
        count: 1,
        items: [
          {
            key: 'FB-1',
            title: expect.any(String),
            next: 'triage it',
            opens: { kind: 'feedback', key: 'FB-1' },
          },
        ],
      },
    ]);
    // the attention total counts it beside the decisions; the decisions badge does not
    expect(attention.total as number).toBeGreaterThanOrEqual(1 + (part?.total as number));
    const items = ok(await say('owner', 'GET', `/api/projects/${projectId}/needs-you`));
    expect((items.items as Doc[]).map((i) => i.key)).toContain('FB-1');
    const decisions = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/needs-you/decisions`),
    );
    expect(decisions.notDecisions as Doc[]).toContainEqual(
      expect.objectContaining({ reason: 'triage', count: 1 }),
    );
    // an outsider holds no triage there and reads no part of that project
    const theirs = ok(await say('outsider', 'GET', '/api/me/attention'));
    expect((theirs.needsYou as Doc[]).map((p) => p.projectSlug)).not.toContain(slug);
  });

  it('ranks Moving by last move, newest first, with the idle folded last', async () => {
    const home = ok(await say('owner', 'GET', '/api/me/home'));
    const moving = home.moving as Doc[];
    expect(moving.map((m) => m.key)).toEqual(['ISS-6', 'ISS-3', 'ISS-2', 'ISS-4']);
    const idle = moving.filter((m) => m.idle);
    expect(idle.map((m) => m.key)).toEqual(['ISS-4']);
    const idleMs = HOME_IDLE_DAYS * 24 * HOUR;
    for (const m of moving) {
      const age = Date.now() - Date.parse(m.lastMovedAt);
      expect(m.idle).toBe(age > idleMs);
    }
    expect(Date.parse(moving[0]?.lastMovedAt)).toBeGreaterThanOrEqual(
      hoursAgo(1).getTime() - 60_000,
    );
  });

  it("names each readable project's latest release and how many of the person's items it carried", async () => {
    const home = ok(await say('owner', 'GET', '/api/me/home'));
    const live = home.live as Doc[];
    expect(live.map((l) => l.version)).toEqual(['1.2.0']);
    expect(live[0]).toMatchObject({ environment: 'production', mine: 1 });
  });

  it('finds a live item as live since its version, a moving one at its stage, and nothing the person cannot read', async () => {
    const find = async (q: string) =>
      ok(await say('owner', 'GET', `/api/me/home/find?q=${encodeURIComponent(q)}`)).items as Doc[];
    const [liveOne] = await find('ISS-1');
    expect(liveOne).toMatchObject({
      key: 'ISS-1',
      standing: { kind: 'live', environment: 'production', version: '1.2.0' },
    });
    expect(liveOne?.standing.since).toBe(T(5).toISOString());
    const [moving] = await find('ISS-3');
    expect(moving).toMatchObject({ key: 'ISS-3', standing: { kind: 'moving', stage: 'landed' } });
    const [dropped] = await find('ISS-5');
    expect(dropped).toMatchObject({ standing: { kind: 'ended', how: 'dropped' } });
    // a title word, across the readable project only: the hidden project's `issue 1` is not found
    const byWord = await find('issue');
    expect(byWord.length).toBeGreaterThan(0);
    expect(new Set(byWord.map((f) => f.projectSlug))).toEqual(new Set([slug]));
  });

  it('says how many items a search matched and whether its list was cut', async () => {
    const few = ok(await say('owner', 'GET', '/api/me/home/find?q=ISS-3'));
    expect(few).toMatchObject({ total: 1, truncated: false });
    // the busy project's 52 issues all hold `issue` in their title
    const many = ok(await say('busy', 'GET', '/api/me/home/find?q=issue'));
    expect(many.items as Doc[]).toHaveLength(HOME_FIND_LIMIT);
    expect(many).toMatchObject({ total: HOME_MOVING_LIMIT + 2, truncated: true });
  });

  it('refuses a query too short to search, by name', async () => {
    const res = await say('owner', 'GET', '/api/me/home/find?q=a');
    expect(res.status).toBe(400);
  });

  it("gives the outsider their own project's release, never the owner's", async () => {
    const home = ok(await say('outsider', 'GET', '/api/me/home'));
    expect((home.live as Doc[]).map((l) => l.version)).toEqual(['9.9.9']);
    expect((home.moving as Doc[]).map((m) => m.key)).toEqual(['ISS-2']);
  });
});

// ISS-926: a read-only member's issue standing grouped the decision on an issue needs_you while it
// named the writers as owing it, and their /attention counted it against them.
describe("an issue's act on a person's Needs you", () => {
  let as: ReturnType<typeof requester>;
  let decided = '';
  let decidedSlug = '';
  const keys = ['ISS-1', 'ISS-2', 'ISS-3'];
  const questionId = randomUUID();

  beforeAll(async () => {
    const { app } = await import('../../src/index.js');
    const { signUserToken } = await import('../../src/credentials/jwt.js');
    const { askQuestion } = await import('../../src/questions/index.js');
    // a question asked enqueues its notice
    await startQueue();
    const writer = (await createTestUser({ verified: true })).id;
    const reader = (await createTestUser({ verified: true })).id;
    ({ id: decided, slug: decidedSlug } = await createTestProject(writer));
    await addProjectMember(decided, reader, 'viewer');
    as = requester(app, {
      writer: await signUserToken(writer),
      reader: await signUserToken(reader),
    });
    const now = new Date();
    // ISS-1: a run asked a person a question on it; ISS-2: parked for a decision; ISS-3: a draft
    const asked = await createTestIssue(decided, writer, 1, { status: 'open', createdAt: now });
    await createTestIssue(decided, writer, 2, {
      status: 'needs_info',
      waitingKind: 'needs_decision',
      createdAt: now,
    });
    await createTestIssue(decided, writer, 3, { status: 'draft', createdAt: now });
    await askQuestion({
      id: questionId,
      projectId: decided,
      issueId: asked.id,
      prompt: 'Keep the old export format or move to the new one?',
      blockerKind: 'human',
      answer: {
        shape: 'choice',
        options: ['keep', 'move'].map((id) => ({
          id,
          label: id,
          authority: 'writer' as const,
          bindsTo: 'session' as const,
          executedBy: 'agent' as const,
        })),
        recommendedOptionId: 'move',
      },
    });
  }, 120_000);

  const standingOf = async (who: string) => {
    const list = ok(await as(who, 'GET', `/api/projects/${decided}/issues/standing`));
    return new Map((list.issues as Doc[]).map((i) => [i.key as string, i.standing as Doc]));
  };
  const attentionOf = async (who: string) => {
    const attention = ok(await as(who, 'GET', '/api/me/attention'));
    return (attention.needsYou as Doc[]).find((p) => p.projectSlug === decidedSlug) ?? null;
  };

  // ISS-687 (REQ-68 BC-6): no issue waits on its reader, whoever reads it: an answer names the writers
  // who may give it, and a draft is the master's to take on or drop
  const readsNoIssueAsTheirs = (standing: Map<string, Doc>) => {
    for (const key of keys) {
      const s = standing.get(key);
      expect(s?.attentionGroup, key).not.toBe('needs_you');
      expect(s?.waitingOn.kind, key).not.toBe('you');
      expect(s?.waitingOn.who, key).not.toBe('You');
    }
    expect(standing.get('ISS-1')?.waitingOn).toMatchObject({
      kind: 'person',
      act: 'answer a question',
    });
    expect(standing.get('ISS-2')?.waitingOn).toMatchObject({
      kind: 'person',
      act: 'make a decision',
    });
    expect(standing.get('ISS-3')?.waitingOn).toMatchObject({
      kind: 'master',
      act: 'take on or drop',
    });
  };

  it('reads an answer a read-only member cannot give as waiting on the writers, and a draft on the master', async () => {
    readsNoIssueAsTheirs(await standingOf('reader'));
  });

  it("counts no decision and no owed row of them on the read-only member's /attention", async () => {
    const part = await attentionOf('reader');
    const listed = [
      ...((part?.decisions as Doc[] | undefined) ?? []).map((d) => d.key),
      ...((part?.owed as Doc[] | undefined) ?? []).flatMap((o) =>
        (o.items as Doc[]).map((i) => i.key),
      ),
    ];
    for (const key of keys) expect(listed).not.toContain(key);
    expect(part?.total ?? 0).toBe(0);
    const items = ok(await as('reader', 'GET', `/api/projects/${decided}/needs-you`));
    expect((items.items as Doc[]).map((i) => i.key)).toEqual(expect.not.arrayContaining(keys));
  });

  // REQ-68 BC-6: Needs you lists no issue; the run's question on ISS-1 is a decision of its own, and
  // the writer who may answer it reads the issue as waiting on the writers by name, never as theirs
  it("reads no issue as the writer's own, and keeps the question on ISS-1 a decision of their Needs you", async () => {
    readsNoIssueAsTheirs(await standingOf('writer'));
    const part = await attentionOf('writer');
    const decisions = (part?.decisions as Doc[] | undefined) ?? [];
    expect(decisions.map((d) => d.key)).toContain(questionId);
    for (const key of keys) expect(decisions.map((d) => d.key)).not.toContain(key);
    expect(part?.total as number).toBeGreaterThanOrEqual(1);
  });
});
