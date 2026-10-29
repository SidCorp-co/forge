// ISS-758 (REQ-48 BC-5, REQ-68 BC-3): one reading of who owes an act, shared by the steward and
// Needs you. On dev.356 (judge K148) REQ-65's re-pin waited on a person kind, so the steward read it
// as a person's act and asked the master nothing (`steward/ask-addressee.ts:waitsOnPerson`), while
// Needs you left it off every person's list because the master's account may take it
// (`development/needs-you-agent-takes.ts`): it was on nobody's list. A real re-pin is planted here (a
// requirement agreed on a design at r1, the design then approved at r2), served by a master box whose
// checkout credential the project's agent holds, and driven through the real app, outbox, standing
// read and steward runtime on a throwaway Postgres, the gateway a scripted provider.
//
// @direct-test-of packages/core/src/steward/ask-addressee.ts
// @direct-test-of packages/core/src/steward/asks.ts
// @direct-test-of packages/core/src/development/needs-you-agent-takes.ts
// @direct-test-of packages/core/src/steward-ports.ts

import { readFileSync } from 'node:fs';
import type { Said } from '@forge/contracts/said';
import { type ItemStanding, STEWARD_DEBOUNCE_MS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
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
  makeAgreeReady,
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
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let masterId = '';
let flowId = '';
let clock = Date.now();
/** The subjects the steward's standing read carries, so no other row of the world starts a run. */
const shown = new Set<string>();
/** Of those, the ones it reports stuck, as an overdue wait would; the rest it reports not stuck. */
const stuckKeys = new Set<string>();
/** Rows the read carries in place of the real ones: the c3 release approval, which needs no release. */
let extra: ItemStanding[] = [];

const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: Doc) => say('owner', method, at(path), body);
const said = (key: string) => ({ key }) as unknown as Said;

function stuck(row: ItemStanding): ItemStanding {
  if (!stuckKeys.has(row.subject.key)) {
    return { ...row, group: row.group === 'stuck' ? 'waiting' : row.group, stuck: null };
  }
  return {
    ...row,
    group: 'stuck',
    stuck: {
      code: 'overdue',
      since: '2026-10-19T00:00:00.000Z',
      reason: `${row.subject.key} is overdue`,
      via: null,
      says: { reason: said('overdue') },
    },
  };
}

/** A requirement agreed on the design at its current revision: re-pinned only once it moves on. */
async function agreedOnFlow(title: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'a discharged patient is called back',
      criteria: [{ body: 'A discharged patient who needs follow-up is called.' }],
    }),
    201,
  ).key as string;
  ok(await as('POST', `/requirements/${key}/workflows`, { workflowId: flowId }));
  ok(
    await as('PUT', `/requirements/${key}/criteria/BC-1/steps`, {
      workflow: flowId,
      steps: ['case'],
    }),
  );
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'ok' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' }));
  return key;
}

/** Ends every steward run already queued (the setup's own events start some), acting on nothing. */
async function drain() {
  await settleOutbox();
  resetScript();
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
}

/** One steward run on `key`'s stuck standing, its turn asking the master to take the act. */
async function askRun(key: string) {
  await drain();
  shown.add(key);
  stuckKeys.add(key);
  clock += STEWARD_DEBOUNCE_MS * 10;
  await steward.sweepStandings(new Date(clock));
  await settleOutbox();
  resetScript();
  script.steps = [
    {
      tool: {
        name: 'steward_wake_master',
        args: { about: key, ask: `Take the act ${key} waits on.` },
      },
    },
    { text: 'Asked.' },
  ];
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
  stuckKeys.delete(key);
}

/** Every ask of the master ever written about `key`. */
const masterAsksAbout = (key: string) =>
  rows<{ id: string }>(sql`
    SELECT id FROM steward_acts WHERE project_id = ${projectId} AND master_ask LIKE ${`${key}: %`}`);

/** What the steward's last turn was told, as one string. */
const lastTurn = () => JSON.stringify(script.sent.at(-1));

/** The owner's Needs you: the keys it lists as decisions, and those it leaves to the master. */
async function needsYou(): Promise<{ listed: string[]; masterTakes: string[] }> {
  const read = ok(await as('GET', '/needs-you/decisions'));
  const taken = (read.notDecisions as Doc[]).find((n) => n.reason === 'agent_takes');
  return {
    listed: (read.decisions as Doc[]).map((d) => d.key as string),
    masterTakes: ((taken?.items as Doc[] | undefined) ?? []).map((i) => i.key as string),
  };
}

const setMasterRole = (role: 'member' | 'viewer') =>
  rows(sql`
    UPDATE project_members SET role = ${role}
     WHERE project_id = ${projectId} AND user_id = ${masterId} RETURNING user_id`);

let repinMasterTakes = '';
let repinPersonOwes = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  const { openStandings } = await import('../../src/standing/index.js');
  provideStewardStandings(async (pid) => {
    const real = (await openStandings(pid)).filter(
      (r) => shown.has(r.subject.key) && !extra.some((e) => e.subject.key === r.subject.key),
    );
    return [...real, ...extra].map(stuck);
  });
  await startQueue();
  steward = {
    ...(await import('../../src/steward/dispatch.js')),
    ...(await import('../../src/steward/sweep.js')),
  } as Steward;
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor, workspaceTokenNameFor } = await import(
    '../../src/credentials/pat-format.js'
  );
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // the project's master: a box serving it, whose checkout carries the agent member's credential
  masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  const deviceId = await createTestDevice(masterId);
  await bindTestRunner(projectId, deviceId);
  const pat = await mintPat({
    userId: masterId,
    name: deviceTokenNameFor(deviceId),
    permissions: ['*'],
    deviceId,
  });
  await mintPat({
    userId: masterId,
    name: workspaceTokenNameFor(deviceId, projectId),
    permissions: ['*'],
    deviceId,
    projectIds: [projectId],
  });
  say = requester(app, { owner: await signUserToken(ownerId), master: pat.plaintext });

  const design = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  design.project = projectId;
  design.flow = 'followed';
  const made = ok(
    await say('master', 'POST', at('/workflows'), { baseRevision: null, document: design }),
    201,
  );
  flowId = made.document.id as string;
  ok(await say('master', 'POST', at(`/workflows/${flowId}/design/propose`), { revision: 1 }));
  ok(
    await as('POST', `/workflows/${flowId}/design/decision`, { revision: 1, decision: 'approve' }),
  );
  repinMasterTakes = await agreedOnFlow('The coordinator reaches the patient');
  repinPersonOwes = await agreedOnFlow('The coordinator writes the call down');
  // the design moves on to r2: both requirements now wait on a re-pin
  const current = ok(await say('master', 'GET', at(`/workflows/${flowId}`)));
  const { id: _id, createdAt: _c, updatedAt: _u, ...doc } = current.document;
  doc.summary = 'revision two, same steps';
  ok(
    await say('master', 'PUT', at(`/workflows/${flowId}`), {
      baseRevision: current.revision,
      document: doc,
    }),
  );
  ok(
    await as('POST', `/workflows/${flowId}/design/decision`, {
      revision: current.revision + 1,
      decision: 'approve',
    }),
  );
  await settleOutbox();
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

describe('the planted re-pin waits on a person kind, as REQ-65 did on dev.356', () => {
  it('reads as a person wait naming the re-pin act', async () => {
    const { openStandings } = await import('../../src/standing/index.js');
    const row = (await openStandings(projectId)).find((r) => r.subject.key === repinMasterTakes);
    expect(row?.waitingOn.kind).toBe('person');
    expect(row?.waitingOn.says.act.key).toBe('standing.acts');
    expect(JSON.stringify(row?.waitingOn.says.act)).toContain('standing.act.updateToDesign');
  });
});

describe('a re-pin the master may take is asked of the master, and is on no person list (c1)', () => {
  it('Needs you leaves it to the master', async () => {
    await setMasterRole('member');
    const read = await needsYou();
    expect(read.masterTakes).toContain(repinMasterTakes);
    expect(read.listed).not.toContain(repinMasterTakes);
  });

  it('the steward asks the master, never reading it as a person act', async () => {
    await askRun(repinMasterTakes);
    expect(lastTurn()).not.toContain("a person's act");
    expect(await masterAsksAbout(repinMasterTakes)).toHaveLength(1);
  });

  it('the sweep keeps that ask while the standing holds', async () => {
    clock += 60_000;
    expect((await steward.sweepStandings(new Date(clock))).settledAsks).toBe(0);
    const open = await steward.openStewardAsks(projectId);
    expect(open.filter((a) => a.ask.startsWith(`${repinMasterTakes}:`))).toHaveLength(1);
  });
});

describe('a re-pin the master may not take is the person’s, and the master is asked nothing (c2)', () => {
  it('Needs you lists it for the owner once the master holds no write', async () => {
    await setMasterRole('viewer');
    const read = await needsYou();
    expect(read.listed).toContain(repinPersonOwes);
    expect(read.masterTakes).not.toContain(repinPersonOwes);
  });

  it('the steward writes no ask of the master, and the turn is told a person owes it', async () => {
    await askRun(repinPersonOwes);
    expect(await masterAsksAbout(repinPersonOwes)).toEqual([]);
    expect(lastTurn()).toContain(`${repinPersonOwes} waits on`);
    expect(lastTurn()).toContain("a person's act");
  });

  it('an ask of the master standing from before is settled once the master may not take it', async () => {
    clock += 60_000;
    await steward.sweepStandings(new Date(clock));
    const open = await steward.openStewardAsks(projectId);
    expect(open.filter((a) => a.ask.startsWith(`${repinMasterTakes}:`))).toEqual([]);
  });
});

describe('a release approval a person kind names stays a held act (c3, boundary)', () => {
  it('routes to the approve holders, never as a person act', async () => {
    await setMasterRole('viewer');
    const made = await createTestIssue(projectId, ownerId, 9001, {
      status: 'open',
      createdAt: new Date(),
    });
    const subject = { kind: 'issue' as const, id: made.id, key: made.key };
    extra = [
      {
        subject,
        title: made.key,
        group: 'moving',
        waitingOn: {
          kind: 'person',
          who: 'release approvers',
          act: 'approve the release',
          rule: 'the rule the read names',
          ref: null,
          dueAt: null,
          says: {
            who: said('standing.who.named'),
            act: said('issues.standing.act.approveOnReleases'),
            rule: said('rule'),
          },
        },
        note: null,
        actClass: 'release_cut',
        since: '2026-10-15T00:00:00.000Z',
        dueAt: '2026-10-19T00:00:00.000Z',
        stuck: null,
        carriedBy: null,
        basis: 'c3-release-approval',
      },
    ];
    await askRun(made.key);
    expect(lastTurn()).toContain('"askedOf\\":\\"releases.approve');
    expect(lastTurn()).not.toContain("a person's act");
    extra = [];
  });
});
