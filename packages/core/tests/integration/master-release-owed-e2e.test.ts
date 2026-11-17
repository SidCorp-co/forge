/**
 * ISS-1278 (adminhub-api, 2026-11-17): ISS-243 sat at `awaiting_release` with release 0.26.0 drafted,
 * and `GET /releases` said it waited on the Master to open the promotion change request. At the same
 * moment core retired the master (`nothing claimable 60m`) and withheld a new one (`nothing_owed`),
 * since the act was not one the owed read knew. Here one landed issue waits on a promotion no request
 * carries: the release page names the master, and the verdict on its pane reads that same wait, so
 * an idle pane is kept, and an absent one — the plant retires it by hand — is placed on the next
 * sweep, its reason naming the release. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/master-owed-acts.ts
 * @direct-test-of packages/core/src/masters/verdict.ts
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/masters/service.ts
 */

import { type MasterFacts, masterFactsSchema } from '@forge/contracts/master-verdict';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { judgeMaster } from '../../src/masters/service.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { bindTestRunner, createTestDevice } from '../helpers/factories.js';
import {
  call,
  EXTERNAL,
  LANDED,
  landedIssues,
  seedPromotionWorld,
  world,
} from '../helpers/promotion-world.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    compare: async () => 'diverged',
    readChangeRequestChecks: async () => [],
  }),
}));

const HOUR = 3600;
let box = { deviceId: '', runnerId: '' };

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
  judgeMaster({ ...box, projectId: world.projectId, facts: facts(pane) });

/** The one drafted release and whom the release page says it waits on. */
async function drafted(): Promise<{ version: string; waitingOn: { who: string; act: string } }> {
  const listed = await call('GET', '/releases');
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const releases = (listed.body as { releases: Array<{ state: string }> }).releases;
  const draft = releases.find((r) => r.state === 'draft');
  expect(draft, JSON.stringify(releases)).toBeDefined();
  return draft as never;
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
  await seedPromotionWorld(EXTERNAL);
  await landedIssues([LANDED[0] as string]);
  const deviceId = await createTestDevice(world.ownerId);
  box = { deviceId, runnerId: await bindTestRunner(world.projectId, deviceId) };
});

describe('a release waiting on the Master is the master’s owed work (ISS-1278)', () => {
  it('replay: the release page names the Master, and its idle pane is kept, not retired', async () => {
    const release = await drafted();
    expect(release.waitingOn).toMatchObject({
      who: 'Master',
      act: 'open the promotion change request at a judged head',
    });

    const answer = await sweep('alive');
    expect(answer.verdict.act, answer.verdict.because).not.toBe('retire');
    expect(answer.verdict).toMatchObject({ act: 'keep', nudge: true });
    expect(answer.work.owed).toBe(1);
    expect(answer.work.nudge).toContain(`${release.version}: open the promotion change request`);
  });

  it('plant: a master retired by hand is placed on the next sweep, the reason naming the release', async () => {
    const { version } = await drafted();
    // the pane is gone: what the box reports after a hand retirement, its conversation still held
    const answer = await sweep('absent');
    expect(answer.verdict.act, answer.verdict.because).toBe('place');
    expect(answer.verdict.because).toContain(
      `1 release(s) wait on the master: ${version}: open the promotion change request at a judged head`,
    );
  });
});
