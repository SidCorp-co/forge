/**
 * ISS-1278 c2: after the release acts were folded in, the dev.714 judge read open items whose standing
 * waited on the Master ("resume it", "propose or drop r1") while placement counted none of them, so a
 * project whose only owed act was one of those read `nothing_owed`. Here each project holds one such
 * act and nothing claimable: an issue a person paused, an agent's draft requirement, a feedback item
 * whose carrier was paused, a workflow whose design is drafting. The standing read names the Master,
 * and the verdict on its pane reads that same wait: an idle pane is kept, and an absent one is placed
 * on the next sweep, its reason naming the act. Against real Postgres.
 *
 * @direct-test-of packages/core/src/standing/master-owed.ts
 * @direct-test-of packages/core/src/lib/master-wait.ts
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/masters/verdict.ts
 */

import { type MasterFacts, masterFactsSchema } from '@forge/contracts/master-verdict';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { judgeMaster } from '../../src/masters/service.js';
import { openStandings } from '../../src/standing/index.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';

const HOUR = 3600;
let world = { projectId: '', ownerId: '', deviceId: '', runnerId: '' };

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
