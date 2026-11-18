/**
 * ISS-1278 c2: after the release acts were folded in, the dev.714 judge read open items whose standing
 * waited on the Master ("resume it", "propose or drop r1") while placement counted none of them, so a
 * project whose only owed act was one of those read `nothing_owed`. Here each project holds one such
 * act and nothing claimable: an issue a person paused, an agent's draft requirement, a feedback item
 * whose carrier was paused, a workflow whose design is drafting. The standing read names the Master,
 * and the verdict on its pane reads that same wait: an idle pane is kept, and an absent one is placed
 * on the next sweep, its reason naming the act. Against real Postgres.
 *
 * ISS-1282 (FB-710): a decision the master records at the door its wake names for the item's kind,
 * bounded by a date to come or a condition, holds the item off the owed work; one with neither, or
 * one written on another item, holds nothing.
 *
 * @direct-test-of packages/core/src/standing/master-owed.ts
 * @direct-test-of packages/core/src/lib/master-wait.ts
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/masters/verdict.ts
 * @direct-test-of packages/core/src/masters/admissible-line.ts
 *
 * ISS-1297 (FB-720): an admissible row the master passed over with such a decision is off its line
 * until the date passes, and while every run slot of the project is in use the line asks no build.
 */

import { type MasterFacts, masterFactsSchema } from '@forge/contracts/master-verdict';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { judgeMaster } from '../../src/masters/service.js';
import { masterStandingsOwed, openStandings } from '../../src/standing/index.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestRunSession,
  createTestUser,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const HOUR = 3600;
let world = { projectId: '', ownerId: '', deviceId: '', runnerId: '' };
let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let app: Parameters<typeof requester>[0];
let signUserToken: (userId: string) => Promise<string>;

/** The box's facts on a master that has done nothing for an hour, its pane as given. */
function facts(pane: 'alive' | 'absent'): MasterFacts {
  return masterFactsSchema.parse({
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane,
    capability: pane === 'alive' ? 'current' : null,
    serversReadable: true,
    work: { poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-1', transcript: 'present', elsewhere: 'none' },
    placement: null,
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: HOUR,
      pane:
        pane === 'alive' ? { doing: 'idle', lastEvent: 'Stop', lastEventAgoSeconds: HOUR } : null,
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: { last: null, since: 'unreported' },
  });
}

const sweep = (pane: 'alive' | 'absent') =>
  judgeMaster({
    deviceId: world.deviceId,
    runnerId: world.runnerId,
    projectId: world.projectId,
    facts: facts(pane),
  });

const hourAgo = () => new Date(Date.now() - HOUR * 1000);

/** The open items whose standing waits on the Master, as `GET /standings` reads them: `key: act`. */
async function masterWaits(): Promise<string[]> {
  return (await openStandings(world.projectId))
    .filter((i) => i.waitingOn.who === 'Master' || i.waitingOn.who === "The project's master")
    .map((i) => `${i.subject.key}: ${i.waitingOn.act}`);
}

/**
 * One project holding one act on the Master: the replay keeps its idle pane, and the plant (its pane
 * retired by hand) places one on the next sweep, the reason naming the act.
 */
async function owedOnly(act: string): Promise<void> {
  const answer = await sweep('alive');
  expect(answer.verdict.act, answer.verdict.because).not.toBe('retire');
  expect(answer.verdict).toMatchObject({ act: 'keep', nudge: true });
  expect(answer.work.admissible).toBe(0);
  expect(answer.work.owed).toBe(1);
  expect(answer.work.nudge).toContain(act);

  const placed = await sweep('absent');
  expect(placed.verdict.act, placed.verdict.because).toBe('place');
  expect(placed.verdict.because).toContain(`1 act(s) wait on the master: ${act}`);
}

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  ({ signUserToken } = await import('../../src/credentials/jwt.js'));
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  world = { projectId, ownerId, deviceId, runnerId: await bindTestRunner(projectId, deviceId) };
  const as = requester(app, { owner: await signUserToken(ownerId) });
  say = (method, path, body) => as('owner', method, path, body);
});

describe('every open item waiting on the Master is the master’s owed work (ISS-1278 c2)', () => {
  it('an issue a person paused: "resume it"', async () => {
    const { key } = await createTestIssue(world.projectId, world.ownerId, 1, {
      status: 'on_hold',
      createdAt: hourAgo(),
    });
    expect(await masterWaits()).toEqual([`${key}: resume it`]);
    await owedOnly(`${key}: resume it`);
  });

  it('an agent’s draft requirement: "propose or drop r1"', async () => {
    const { id, key } = await createTestRequirement(world.projectId, 1, 'Exports keep their order');
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await db.execute(sql`UPDATE requirements SET owner_id = ${world.ownerId} WHERE id = ${id}`);
    await db.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, spec, author_id, author_agency)
      VALUES (${id}, 1, '{}'::jsonb, ${agent}, 'agent')
    `);
    expect(await masterWaits()).toEqual([`${key}: propose or drop r1`]);
    await owedOnly(`${key}: propose or drop r1`);
  });

  it('a feedback item whose carrier was paused: counted once, on its carrier', async () => {
    const issue = await createTestIssue(world.projectId, world.ownerId, 1, {
      status: 'on_hold',
      createdAt: hourAgo(),
    });
    const fb = await createTestFeedback(world.projectId, world.ownerId, 1, [issue.id]);
    const waits = await masterWaits();
    expect(waits).toContain(`${issue.key}: resume it`);
    expect(waits.find((w) => w.startsWith(`${fb}: `))).toMatch(/resume it on/);
    await owedOnly(`${issue.key}: resume it`);
  });

  it('a claimable issue stays the admissible read’s, never counted twice as owed', async () => {
    const { key } = await createTestIssue(world.projectId, world.ownerId, 1, {
      status: 'open',
      createdAt: hourAgo(),
    });
    expect(await masterWaits()).toEqual([`${key}: dispatch a run`]);
    const answer = await sweep('absent');
    expect(answer.verdict.act, answer.verdict.because).toBe('place');
    expect(answer.work).toMatchObject({ admissible: 1, owed: 0 });
    expect(answer.verdict.because).not.toContain('wait on the master');
  });

  it('a workflow whose design is drafting: "finish it"', async () => {
    await db.execute(sql`
      INSERT INTO project_workflows (project_id, flow, kind, revision, document, design_status, written_by_user)
      VALUES (${world.projectId}, 'refunds', 'flow', 1, '{}'::jsonb, 'draft', ${world.ownerId})
    `);
    const [wait] = await masterWaits();
    expect(wait).toMatch(/^refunds: /);
    await owedOnly(wait as string);
  });
});

/** An agent's draft requirement owner-held by the project's owner: its standing waits on the Master. */
async function agentDraft(): Promise<{ id: string; key: string }> {
  const req = await createTestRequirement(world.projectId, 1, 'Exports keep their order');
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await db.execute(sql`UPDATE requirements SET owner_id = ${world.ownerId} WHERE id = ${req.id}`);
  await db.execute(sql`
    INSERT INTO requirement_revisions (requirement_id, revision, spec, author_id, author_agency)
    VALUES (${req.id}, 1, '{}'::jsonb, ${agent}, 'agent')
  `);
  return req;
}

/** A decision comment at a requirement's, feedback item's or workflow's own door, as the wake names it. */
const decideOn = (path: string, reversedWhen?: string) =>
  say('POST', `/api/projects/${world.projectId}/${path}/comments`, {
    intent: 'decision',
    decision: {
      decision: 'Keep it waiting.',
      reason: 'The BA who agrees it is not yet a member of the project.',
      ...(reversedWhen ? { reversedWhen } : {}),
    },
  });

/** The sweep owes nothing for the item, and its wake names it nowhere. */
async function heldOff(key: string): Promise<void> {
  const answer = await sweep('alive');
  expect(answer.work.owed, answer.verdict.because).toBe(0);
  expect(answer.work.nudge ?? '').not.toContain(key);
}

describe('a decision at its own door holds the item off the master’s owed work (ISS-1282)', () => {
  it('a requirement: a decision comment naming a condition holds it, its page naming the hold', async () => {
    const { key } = await agentDraft();
    await owedOnly(`${key}: propose or drop r1`);
    ok(await decideOn(`requirements/${key}`, 'until the BA joins the project'), 201);
    const [standing] = (await openStandings(world.projectId)).filter((i) => i.subject.key === key);
    expect(standing?.waitingOn.rule).toContain('until the BA joins the project');
    await heldOff(key);
  });

  it('a requirement: a decision with neither date nor condition holds nothing (boundary)', async () => {
    const { key } = await agentDraft();
    ok(await decideOn(`requirements/${key}`), 201);
    await owedOnly(`${key}: propose or drop r1`);
  });

  it('an issue: a decision record at its events door, `until` a condition, holds it', async () => {
    const { id, key } = await createTestIssue(world.projectId, world.ownerId, 1, {
      status: 'on_hold',
      createdAt: hourAgo(),
    });
    const fields = [
      { key: 'decision', value: 'Keep it paused.' },
      { key: 'why', value: 'The owner paused it for the audit.' },
      { key: 'until', value: 'the owner resumes it' },
    ];
    ok(
      await say('POST', `/api/issues/${id}/events`, { kind: 'decision', contract: 1, fields }),
      201,
    );
    await heldOff(key);
  });

  // its triage is the triage line's to name, so the standing acts read is where its hold shows
  it('a feedback item: a decision comment at its own door, naming a condition, holds it', async () => {
    const key = await createTestFeedback(world.projectId, world.ownerId, 1);
    const acted = async () =>
      (await masterStandingsOwed(world.projectId)).acts.map((a) => a.subject.key);
    expect(await acted()).toContain(key);
    ok(await decideOn(`feedback/${key}`, 'until the reporter answers'), 201);
    expect(await acted()).not.toContain(key);
  });

  it('a workflow: a decision comment at its own door, dated to come, holds it', async () => {
    await db.execute(sql`
      INSERT INTO project_workflows (project_id, flow, kind, revision, document, design_status, written_by_user)
      VALUES (${world.projectId}, 'refunds', 'flow', 1, '{}'::jsonb, 'draft', ${world.ownerId})
    `);
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    ok(await decideOn('workflows/refunds', nextWeek), 201);
    await heldOff('refunds');
  });

  it('a requirement’s wait recorded on another item holds nothing: the FB-710 sequence', async () => {
    const { key } = await agentDraft();
    const issue = await createTestIssue(world.projectId, world.ownerId, 2, {
      status: 'on_hold',
      createdAt: hourAgo(),
    });
    const fields = [
      { key: 'decision', value: `${key} waits for its BA.` },
      { key: 'why', value: 'The BA who agrees it is not yet a member of the project.' },
      { key: 'until', value: 'the BA joins the project' },
    ];
    ok(
      await say('POST', `/api/issues/${issue.id}/events`, {
        kind: 'decision',
        contract: 1,
        fields,
      }),
      201,
    );
    const answer = await sweep('alive');
    expect(answer.work.nudge).toContain(`${key}: propose or drop r1`);
  });
});

/** A pass-over of issue `id` as the line asks it, at the issue's events door, held `until`. */
const passOver = (until: string) => [
  { key: 'decision', value: 'Pass it over.' },
  { key: 'why', value: 'The batch in flight touches the same files.' },
  { key: 'until', value: until },
];

describe('the admissible line asks only what the master can take now (ISS-1297)', () => {
  // the standard profile with fast delivery: the master works direct, so its pass names each row
  beforeEach(async () => {
    await seedProjectDocument(world.projectId, world.ownerId, {
      environments: {
        dev: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
      },
    });
  });

  it('a row passed over until a date to come is not listed, and is listed again once it passes', async () => {
    const { id, key } = await createTestIssue(world.projectId, world.ownerId, 1, {
      status: 'open',
      createdAt: hourAgo(),
    });
    expect((await sweep('alive')).work.nudge).toContain(`${key} ${id}`);
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const fields = passOver(nextWeek);
    ok(
      await say('POST', `/api/issues/${id}/events`, { kind: 'decision', contract: 1, fields }),
      201,
    );
    const held = await sweep('alive');
    expect(held.work.admissible, held.verdict.because).toBe(0);
    expect(held.work.nudge ?? '').not.toContain(key);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.execute(sql`
      UPDATE activity_log SET payload = jsonb_set(payload, '{fields}', ${JSON.stringify(passOver(yesterday))}::jsonb)
       WHERE issue_id = ${id} AND payload ? 'fields'`);
    const back = await sweep('alive');
    expect(back.work.admissible).toBe(1);
    expect(back.work.nudge).toContain(`${key} ${id}`);
  });

  it('while every run slot is in use the line asks no build, and names the row again once one frees', async () => {
    const { id, key } = await createTestIssue(world.projectId, world.ownerId, 1, {
      status: 'open',
      createdAt: hourAgo(),
    });
    await db.execute(sql`UPDATE devices SET max_subagents = 1 WHERE id = ${world.deviceId}`);
    await createTestRunSession(world.projectId, world.deviceId, hourAgo(), null);
    const full = await sweep('alive');
    expect(full.work.nudge).toContain(`1 admissible issue waits for a run slot`);
    expect(full.work.nudge).toContain(`in use: ${key}. Build none`);
    expect(full.work.nudge).not.toContain('open for you to build');

    // a slot frees: the box declares room for a second subagent (a run's close moves its session through the kernel)
    await db.execute(sql`UPDATE devices SET max_subagents = 2 WHERE id = ${world.deviceId}`);
    const freed = await sweep('alive');
    expect(freed.work.nudge).toContain(`1 admissible issue is open for you to build`);
    expect(freed.work.nudge).toContain(`${key} ${id}`);
    expect(freed.work.digest).not.toBe(full.work.digest);
  });
});
