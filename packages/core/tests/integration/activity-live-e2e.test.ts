/**
 * ISS-951 round 2 (MK-9): the owner must see what each master does, live, to tell whether it runs.
 * forge-core-61's live read found the workspace read took 25-34 s, a master's state followed its
 * declaration and its pass rather than its pane, an issue built with a merge request open read
 * triage, and 17 questions read "A question a run asked" with a uuid. Each of those, here:
 *
 * 1. the workspace read sends the same statements for its masters, its releases and the decisions
 *    owed however many projects it has (only the admissible backlog, by each project's own policy,
 *    is read per project), and a cold read answers within its budget, saying what is still pending;
 * 2. the master's beat carries its pane's hooks to the standing and the org row, and tells the
 *    pages only when `doing` moves;
 * 3. a settled pass, or one the pane said ended, no longer reads in a pass; a pane working with no
 *    pass reads busy; `since` is the state's own time, never the declaration's;
 * 4. a change request opened for an issue moves its step to build, never back from test;
 * 6. a question waiting on the reader shows its own words and the issue it is asked on.
 *
 * @direct-test-of packages/core/src/activity/read.ts
 * @direct-test-of packages/core/src/activity/release-glance.ts
 * @direct-test-of packages/core/src/activity/recent.ts
 * @direct-test-of packages/core/src/activity/routes.ts
 * @direct-test-of packages/core/src/masters/read.ts
 * @direct-test-of packages/core/src/masters/state.ts
 * @direct-test-of packages/core/src/masters/service.ts
 * @direct-test-of packages/core/src/masters/device-routes.ts
 * @direct-test-of packages/core/src/issues/work-state.ts
 * @direct-test-of packages/core/src/integrations/source-host/projection.ts
 * @direct-test-of packages/core/src/integrations/work-evidence.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  seedOrg,
} from '../helpers/factories.js';

let ownerId = '';
let token = '';
let box = '';
let orgId = '';
let projectId = '';
let smallOrg = '';
let bigOrg = '';
let sessionId = '';

const rows = async <T>(q: ReturnType<typeof sql>) => [...((await db.execute(q)) as Iterable<T>)];

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  token = await userToken(ownerId);
  orgId = await seedOrg(ownerId);
  projectId = (await createTestProject(ownerId, { orgId })).id;
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: ownerId,
      name: 'box-activity-live',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-activity',
    maxJobPanes: 2,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
  sessionId = String((master.body as Doc).sessionId);
  // the declaration is an hour old, so a `since` read from it is told apart from the state's own
  await db.execute(sql`
    UPDATE agent_sessions SET started_at = now() - interval '1 hour' WHERE id = ${sessionId}`);

  smallOrg = await seedOrg(ownerId);
  bigOrg = await seedOrg(ownerId);
  for (const [org, n] of [
    [smallOrg, 2],
    [bigOrg, 6],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const p = (await createTestProject(ownerId, { orgId: org })).id;
      const at = new Date(Date.now() - 3_600_000);
      await createTestIssue(p, ownerId, 1, { status: 'in_progress', createdAt: at });
      await createTestIssue(p, ownerId, 2, { status: 'open', createdAt: at, priority: 'high' });
      await createTestIssue(p, ownerId, 3, {
        status: 'awaiting_release',
        createdAt: at,
        mergedAt: at,
      });
    }
  }
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

const standing = async () => {
  const res = await api(token, 'GET', `/api/projects/${projectId}/masters/standing`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Doc;
};
/** The project's row, read again while the page would: until nothing is still being read behind it. */
const orgRow = async () => {
  for (let i = 0; ; i++) {
    const res = await api(token, 'GET', `/api/orgs/${orgId}/activity`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (!(res.body as Doc).refreshing || i >= 40) {
      return ((res.body as Doc).projects as Doc[]).find((p) => p.projectId === projectId) as Doc;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
};
const beat = (doing: string, lastEventAgoMs = 1_000, turnBeganAgoMs: number | null = 20_000) =>
  api(box, 'POST', '/api/devices/me/master-session/pane', {
    sessionId,
    pane: { doing, lastEventAgoMs, turnBeganAgoMs, writtenAgoMs: 2_000 },
  });
const pass = (body: Doc) => api(box, 'POST', '/api/devices/me/master-session/pass', body);
const masterFrames = async () =>
  (
    await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pipeline_outbox
       WHERE type = 'session.pushed'
         AND payload->>'event' = 'project.now.changed'
         AND payload->'data'->>'source' = 'master'
         AND payload->>'projectId' = ${projectId}`)
  )[0]?.n ?? 0;

describe('ISS-951 (1) the workspace read is read per workspace, not per project', () => {
  const viewer = () => ({ userId: ownerId, agency: 'human' as const });
  const projectsOf = async (org: string) =>
    (await rows<{ id: string }>(sql`SELECT id FROM projects WHERE org_id = ${org}`)).map((r) =>
      String(r.id),
    );

  it('sends the same statements for 6 projects as for 2, beyond the backlog each project admits by its own policy', async () => {
    const { readOrgActivity } = await import('../../src/activity/read.js');
    const { readAdmissibleForProjects } = await import('../../src/devices/index.js');
    const { newQueryTiming, withQueryTiming } = await import('../../src/db/query-timing.js');
    const counted = async (fn: () => Promise<unknown>) => {
      const t = newQueryTiming();
      await withQueryTiming(t, fn);
      return t.queries;
    };
    // the first read of each holds what it keeps off the path; the counted read is the one after it
    await readOrgActivity(smallOrg, viewer(), new Date(), { waitMs: 60_000 });
    await readOrgActivity(bigOrg, viewer(), new Date(), { waitMs: 60_000 });
    const read = (org: string) => () => readOrgActivity(org, viewer(), new Date(), {});
    const admitted = (ids: string[]) => () => readAdmissibleForProjects(ids, 5);
    const small = await counted(read(smallOrg));
    const big = await counted(read(bigOrg));
    const smallAdmitted = await counted(admitted(await projectsOf(smallOrg)));
    const bigAdmitted = await counted(admitted(await projectsOf(bigOrg)));
    expect(
      big - bigAdmitted,
      `4 more projects sent ${big - small} more statements, ${bigAdmitted - smallAdmitted} of them the backlog`,
    ).toBe(small - smallAdmitted);
  });

  it('a cold read answers within its budget, and says pending, never "none", for what it is still reading', async () => {
    const { readOrgActivity, peopleGlances } = await import('../../src/activity/read.js');
    const { releaseGlances } = await import('../../src/activity/release-glance.js');
    peopleGlances.forget();
    releaseGlances.forget();
    const started = performance.now();
    const cold = await readOrgActivity(bigOrg, viewer(), new Date(), {});
    expect(
      performance.now() - started,
      'a cold read waited on what it keeps off the path',
    ).toBeLessThan(1_000);
    for (const row of cold.projects) {
      if (row.releasePending) expect(row.release, 'a pending release read as none').toBeNull();
      if (row.peoplePending) expect(row.people.total).toBe(0);
    }
    const later = await readOrgActivity(bigOrg, viewer(), new Date(), { waitMs: 60_000 });
    expect(later.projects.map((r) => [r.releasePending, r.peoplePending])).toEqual(
      later.projects.map(() => [false, false]),
    );
    expect(later.refreshing, 'a read with everything held still said it was refreshing').toBe(
      false,
    );
  });
});

describe('ISS-951 (2)(3) the master reads what its pane does', () => {
  it('a busy pane with no pass reads busy, live from the beat, since its turn began', async () => {
    const framesBefore = await masterFrames();
    const res = await beat('working', 1_000, 20_000);
    expect([res.status, (res.body as Doc).changed]).toEqual([200, true]);
    const s = await standing();
    expect(s.state, 'a pane working with no pass open read as idle').toBe('busy');
    expect(s.pane).toMatchObject({ doing: 'working', source: 'beat' });
    expect(
      Date.now() - Date.parse(s.since),
      'since read the declaration, not the turn',
    ).toBeLessThan(120_000);
    const row = await orgRow();
    expect(row.master.state).toBe('busy');
    expect(row.master.pane.doing).toBe('working');
    expect(row.group, 'a busy master is not running on the page').toBe('running');
    expect(await masterFrames(), 'a moved doing told no page').toBe(framesBefore + 1);

    const again = await beat('working', 500, 20_000);
    expect((again.body as Doc).changed).toBe(false);
    expect(await masterFrames(), 'a beat that moved nothing told the pages it moved').toBe(
      framesBefore + 1,
    );
  });

  it('an open pass reads in a pass since it opened; once the pane says its turn ended, it does not', async () => {
    // the pass names its issue by title, read without the key an agent wrote into it (ISS-951 round 4)
    const named = await createTestIssue(projectId, ownerId, 1, {
      status: 'draft',
      createdAt: new Date(),
    });
    await db.execute(
      sql`UPDATE issues SET title = 'FB-7: the pass names its issue' WHERE id = ${named.id}`,
    );
    await beat('idle', 0, null);
    const opened = await pass({ op: 'open', sessionId, verb: 'dispatch', issueKey: 'ISS-1' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const startedAt = String(((opened.body as Doc).pass as Doc).startedAt);
    const during = await standing();
    expect([during.state, during.since]).toEqual(['in_pass', startedAt]);
    expect((await orgRow()).master.doing).toEqual({
      kind: 'pass',
      verb: 'dispatch',
      issueKey: 'ISS-1',
      issueTitle: 'The pass names its issue',
    });

    await new Promise((r) => setTimeout(r, 20));
    await beat('idle', 0, null);
    const after = await standing();
    expect(after.state, 'a pass the pane said ended still read in a pass').toBe('idle');
    expect((await orgRow()).master.doing, 'an ended pass was still named what it does').toBeNull();
  });

  it('a settled pass reads idle since it ended, not since the master was declared', async () => {
    const open = (await standing()).pass as Doc;
    const settled = await pass({
      op: 'settle',
      sessionId,
      passId: open.id,
      facts: {
        openedBy: 'this_daemon',
        served: true,
        openedAgoMs: 5_000,
        hooks: { turnsSinceOpen: 1, turnBeganAgoMs: 4_000, doing: 'idle', lastEventAgoMs: 1_000 },
        writtenAgoMs: null,
        dispatched: [],
        record: { worked: true, refusal: null },
      },
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const endedAt = String(((settled.body as Doc).pass as Doc).endedAt);
    const s = await standing();
    expect([s.state, s.since]).toEqual(['idle', endedAt]);
    const row = await orgRow();
    expect(row.master.lastPassEndedAt).toBe(endedAt);
  });
});

describe('ISS-951 (4) a change request opened for an issue moves its step to build', () => {
  it('moves triage to build, and never moves test back', async () => {
    const { applyPullRequestEvent } = await import(
      '../../src/integrations/source-host/projection.js'
    );
    const connectionId = randomUUID();
    const bindingId = randomUUID();
    await db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'gitlab', true)`);
    await db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
      VALUES (${bindingId}, ${connectionId}, ${projectId}, 'gitlab', 'source', true,
              ${JSON.stringify({ repository: 'acme/app' })}::jsonb)`);
    const claimed = async (seq: number, step: string) => {
      const id = (
        await createTestIssue(projectId, ownerId, seq, {
          status: 'in_progress',
          createdAt: new Date(),
        })
      ).id;
      await db.execute(sql`
        INSERT INTO issue_work_state (issue_id, step, step_started_at, updated_at)
        VALUES (${id}, ${step}, now() - interval '105 minutes', now())`);
      return id;
    };
    const stepOf = async (id: string) =>
      (
        await rows<{ step: string }>(sql`SELECT step FROM issue_work_state WHERE issue_id = ${id}`)
      )[0]?.step;
    const building = await claimed(41, 'triage');
    const judged = await claimed(42, 'test');
    const request = (number: number, seq: number) =>
      applyPullRequestEvent(
        { projectId, bindingId, host: 'gitlab' },
        {
          action: 'open',
          pull_request: {
            number,
            title: `MR ${number}`,
            body: null,
            html_url: `https://gitlab.com/acme/app/-/merge_requests/${number}`,
            state: 'open',
            head: { ref: `feat/ISS-${seq}-thing`, sha: 'a'.repeat(40) },
            base: { ref: 'dev', sha: 'f'.repeat(40) },
            updated_at: new Date().toISOString(),
          },
          repository: { full_name: 'acme/app' },
        },
      );
    await request(135, 41);
    expect(await stepOf(building), 'an issue with its MR open still read triage').toBe('build');
    await request(136, 42);
    expect(await stepOf(judged), 'an MR moved an issue at test back').toBe('test');

    const recent = await api(token, 'GET', `/api/orgs/${orgId}/activity/${projectId}/recent`);
    expect(recent.status, JSON.stringify(recent.body)).toBe(200);
    const items = (recent.body as Doc).items as Doc[];
    expect(items.length).toBeLessThanOrEqual(8);
    expect(items.map((i) => i.kind)).toContain('change_request');
    expect(items.find((i) => i.kind === 'change_request')).toMatchObject({
      ref: expect.stringMatching(/^!13[56]$/),
    });
    expect(items.map((i) => i.kind)).toContain('pass_settled');
    const times = items.map((i) => Date.parse(String(i.at)));
    expect(times, 'Recent is newest first').toEqual([...times].sort((a, b) => b - a));
  });

  it('serves Recent only for a project of the workspace the caller reads', async () => {
    const other = (await createTestProject(ownerId)).id;
    const res = await api(token, 'GET', `/api/orgs/${orgId}/activity/${other}/recent`);
    expect(res.status).toBe(404);
  });
});

describe('ISS-951 (6) a question waiting on the reader reads as itself', () => {
  it('shows the question words on one line and the issue it is asked on, never a uuid', async () => {
    const { askQuestion } = await import('../../src/questions/index.js');
    const { peopleGlances } = await import('../../src/activity/read.js');
    const issue = await createTestIssue(projectId, ownerId, 61, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const id = randomUUID();
    await askQuestion({
      id,
      projectId,
      issueId: issue.id,
      askedBy: ownerId,
      // the asking run led with keys, as ISS-582's did on dev.486 (ISS-951 round 4)
      prompt: `ISS-61 (from hop FB-147): Should the stg vhost change today, or only in the Friday window? ${'Detail that runs past one line. '.repeat(6)}`,
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: 'a day' },
    } as never);
    peopleGlances.forget();
    const row = await orgRow();
    const item = (row.people.items as Doc[]).find((p) => p.key === 'ISS-61');
    expect(item, JSON.stringify(row.people.items)).toBeDefined();
    const title = String(item?.title);
    expect(
      title.startsWith('Should the stg vhost change today, or only in the Friday window?'),
    ).toBe(true);
    expect(title.endsWith('…'), 'a long question was not cut to its line').toBe(true);
    expect(title.length).toBeLessThanOrEqual(140);
    expect(title, 'a key was left in the words a person reads').not.toMatch(/\b(ISS|FB)-\d/);
    expect(JSON.stringify(row.people), 'a question id was shown as text').not.toContain(id);
    expect(JSON.stringify(row.people)).not.toContain('A question a run asked');
  });
});
