// ISS-607 (REQ-48 BC-5): the steward asks whoever can take the act an item waits on. A release
// approval the project's master may not give is asked of the release holders, never of the master;
// a master that holds releases.approve is asked as before. On the standing it reads now an item is
// asked once: a reasoned decision recorded on the item after the ask answers it, the master is owed
// it no more, and nobody is asked again until the standing moves; a moved standing asks again.
// Driven through the real app, outbox and steward runtime on a throwaway Postgres, the gateway a
// scripted provider and the standing read a scripted one, as steward-runtime-e2e does.
//
// @direct-test-of packages/core/src/steward/door-wake.ts
// @direct-test-of packages/core/src/steward/asks.ts
// @direct-test-of packages/core/src/steward/ask-addressee.ts
// @direct-test-of packages/core/src/issues/record-events/decision-read.ts
// @direct-test-of packages/core/src/steward-ports.ts

import type { Said } from '@forge/contracts/said';
import { type ItemStanding, STEWARD_DEBOUNCE_MS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

type Steward = typeof import('../../src/steward/dispatch.js') &
  typeof import('../../src/steward/sweep.js');

let steward: Steward;
let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let masterId = '';
let standings: ItemStanding[] = [];
let clock = Date.now();

/** A sentence the fake read carries, by its registry key; nothing here renders it. */
const said = (key: string) => ({ key }) as unknown as Said;

/** An issue at the release gate, its release waiting on an approval, overdue. */
function releaseWait(issue: { id: string; key: string }, basis: string): ItemStanding {
  const says = {
    who: said('issues.standing.who.release'),
    act: said('issues.standing.act.approveOnReleases'),
    rule: said('issues.rule.approval'),
  };
  return {
    subject: { kind: 'issue', id: issue.id, key: issue.key },
    title: 'issue',
    group: 'stuck',
    waitingOn: {
      kind: 'release',
      who: 'Release',
      act: 'Approve release on Releases',
      rule: 'the project asks a person to approve a release',
      ref: null,
      dueAt: '2026-10-19T00:00:00.000Z',
      says,
    },
    note: null,
    actClass: 'release_cut',
    since: '2026-10-15T00:00:00.000Z',
    dueAt: '2026-10-19T00:00:00.000Z',
    stuck: {
      code: 'overdue',
      since: '2026-10-19T00:00:00.000Z',
      reason: `${issue.key}'s release approval is overdue`,
      via: null,
      says: { reason: said('overdue') },
    },
    carriedBy: null,
    basis,
  };
}

interface ActRead {
  door: string;
  did: string;
  master_ask: string | null;
}
const actsOn = (issueId: string) =>
  rows<ActRead>(sql`
    SELECT a.door, a.did, a.master_ask FROM steward_acts a
      JOIN steward_runs r ON r.id = a.run_id
     WHERE r.subject_id = ${issueId} ORDER BY a.at, a.id`);

const askedOf = (issueId: string) =>
  rows<{ user_id: string }>(sql`
    SELECT dd.user_id FROM notifications n
      JOIN notification_delivery_members dm ON dm.notification_id = n.id
      JOIN notification_deliveries dd ON dd.id = dm.delivery_id
     WHERE n.type = 'steward_ask' AND n.issue_id = ${issueId}`);

/** One steward run on the item's standing now, its turn asking about the item. */
async function askRun(issue: { key: string }, emitFirst: 'sweep' | 'event' = 'sweep') {
  clock += STEWARD_DEBOUNCE_MS * 10;
  if (emitFirst === 'sweep') {
    await steward.sweepStandings(new Date(clock));
  } else {
    // a stuck event on a basis already diagnosed: the repeat a failed run's retry makes
    const { db } = await import('../../src/db/client.js');
    const { emitEvent } = await import('../../src/outbox/index.js');
    const row = standings[0] as ItemStanding;
    await db.transaction((tx) =>
      emitEvent(tx, 'standing.stuck', {
        projectId,
        subject: row.subject,
        basis: row.basis,
        code: 'overdue',
      }),
    );
  }
  await settleOutbox();
  resetScript();
  script.steps = [
    {
      tool: {
        name: 'steward_wake_master',
        args: { about: issue.key, ask: `Approve the release that carries ${issue.key}.` },
      },
    },
    { text: 'Asked who owes the approval.' },
  ];
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
}

const decide = (issueId: string, fields: { key: string; value: string }[]) =>
  say('owner', 'POST', `/api/issues/${issueId}/events`, { kind: 'decision', contract: 1, fields });

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  steward = {
    ...(await import('../../src/steward/dispatch.js')),
    ...(await import('../../src/steward/sweep.js')),
  } as Steward;
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // the project's master: a box serving it, its credential held by an agent member, who may not approve
  masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  const deviceId = await createTestDevice(masterId);
  await bindTestRunner(projectId, deviceId);
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor } = await import('../../src/credentials/pat-format.js');
  await mintPat({
    userId: masterId,
    name: deviceTokenNameFor(deviceId),
    permissions: ['*'],
    deviceId,
  });
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a release approval the master may not give is asked of the release holders (c1)', () => {
  let issue: { id: string; key: string };

  it('tells the release holders and asks the master nothing', async () => {
    issue = await createTestIssue(projectId, ownerId, 71, {
      status: 'awaiting_release',
      createdAt: new Date(),
    });
    standings = [releaseWait(issue, 'release-1')];
    await askRun(issue);
    expect(await steward.openStewardAsks(projectId)).toEqual([]);
    const acts = await actsOn(issue.id);
    expect(acts.map((a) => [a.door, a.master_ask])).toEqual([['NOTIFY release holders', null]]);
    expect(acts[0]?.did).toContain(`about ${issue.key}`);
    expect((await askedOf(issue.id)).map((r) => r.user_id)).toEqual([ownerId]);
  });

  it('does not ask the holders again on the same standing', async () => {
    await askRun(issue, 'event');
    expect((await actsOn(issue.id)).map((a) => a.door)).toEqual(['NOTIFY release holders']);
    expect(await askedOf(issue.id)).toHaveLength(1);
    expect(JSON.stringify(script.sent.at(-1))).toContain('Ask nothing until its standing moves');
  });

  it('asks again once the standing moves', async () => {
    standings = [releaseWait(issue, 'release-2')];
    await askRun(issue);
    expect((await actsOn(issue.id)).map((a) => a.door)).toEqual([
      'NOTIFY release holders',
      'NOTIFY release holders',
    ]);
    expect(await askedOf(issue.id)).toHaveLength(2);
    expect(await steward.openStewardAsks(projectId)).toEqual([]);
    standings = [];
  });
});

describe('a decision recorded on an unchanged wait answers the ask until the standing moves (c2)', () => {
  let issue: { id: string; key: string };

  it('asks a master that holds releases.approve, as before (boundary)', async () => {
    await rows(sql`
      UPDATE project_members SET grants = ARRAY['releases.approve']
       WHERE project_id = ${projectId} AND user_id = ${masterId} RETURNING user_id`);
    issue = await createTestIssue(projectId, ownerId, 72, {
      status: 'awaiting_release',
      createdAt: new Date(),
    });
    standings = [releaseWait(issue, 'approve-1')];
    await askRun(issue);
    const asks = await steward.openStewardAsks(projectId);
    expect(asks.map((a) => a.ask)).toEqual([
      `${issue.key}: Approve the release that carries ${issue.key}.`,
    ]);
    expect(await askedOf(issue.id)).toEqual([]);
  });

  it('keeps the ask where the decision carries no why, a route record', async () => {
    ok(
      await decide(issue.id, [
        { key: 'lead', value: 'FB-9 routed to this issue' },
        { key: 'outcome', value: 'linked' },
      ]),
      201,
    );
    clock += 60_000;
    await steward.sweepStandings(new Date(clock));
    expect(await steward.openStewardAsks(projectId)).toHaveLength(1);
  });

  it('settles the ask once a person records why it waits', async () => {
    ok(
      await decide(issue.id, [
        { key: 'decision', value: 'waits' },
        { key: 'why', value: 'the release waits on production being declared' },
      ]),
      201,
    );
    clock += 60_000;
    const tally = await steward.sweepStandings(new Date(clock));
    expect(tally.settledAsks).toBe(1);
    expect(await steward.openStewardAsks(projectId)).toEqual([]);
  });

  it('does not ask again on the same standing', async () => {
    await askRun(issue, 'event');
    expect(await steward.openStewardAsks(projectId)).toEqual([]);
    expect((await actsOn(issue.id)).map((a) => a.door)).toEqual(['WAKE master.wake steward']);
    expect(JSON.stringify(script.sent.at(-1))).toContain('a decision answered it');
  });

  it('asks again once the standing moves', async () => {
    standings = [releaseWait(issue, 'approve-2')];
    await askRun(issue);
    expect(await steward.openStewardAsks(projectId)).toHaveLength(1);
    expect((await actsOn(issue.id)).map((a) => a.door)).toEqual([
      'WAKE master.wake steward',
      'WAKE master.wake steward',
    ]);
    standings = [];
  });
});
