/**
 * What `closeShippedEarlier` could not settle about a waiting row is said on that row's hold, beside
 * whatever holds it (`release-batch/shipped-earlier-hold.ts`), never on the log alone (ISS-1215).
 * The live shape: rows an aborted release held for a person on a project with no source host
 * binding, swept every tick with nothing on the row saying Forge could not check they shipped.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';
import {
  A,
  B,
  C1,
  HISTORY,
  host,
  N,
  shippedEarlierWorld,
} from '../helpers/shipped-earlier-world.js';

let projectId: string;
let ownerId: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { shipped, marked, asserted, claim, runOf, abortHold } = shippedEarlierWorld(
  () => ({ projectId }),
  fx,
);

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

describe('what the sweep could not settle is on the row, beside the abort (never the log alone)', () => {
  it('names a project with no source host binding on the abort-held row, with what binds it, and rewrites nothing next tick', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await asserted();
    await abortHold(id);
    await claim(id, A);

    // No host is injected: the project's own binding is resolved, and it has none.
    await sweepAutomaticReleases(new Date());

    const held = await fx.holdOf(id);
    expect(held?.code).toBe('RELEASE_ABORT_BLOCKED');
    expect(held?.owes).toBe('human');
    expect(held?.reason).toContain('Nothing to release: already shipped.');
    expect(held?.reason).toContain('SHIPPED_EARLIER_HOST_UNAVAILABLE');
    expect(held?.reason).toContain('no active source host binding');
    expect(held?.reason).toContain('bind its repository on the Integrations page');
    expect(held?.waitingFor).toContain('record these issues as shipped');
    expect(held?.waitingFor).toContain('source host binding');
    expect((await runOf(id))?.status).toBe('awaiting_release');

    const written = (await fx.holdHistory(id)).length;
    await sweepAutomaticReleases(new Date());
    expect((await fx.holdHistory(id)).length).toBe(written);
  });

  it('takes the clause off again once the repository answers, leaving the abort exactly as written', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(N);
    await abortHold(id);
    const original = await fx.holdOf(id);

    await sweepAutomaticReleases(new Date());
    expect((await fx.holdOf(id))?.reason).toContain('SHIPPED_EARLIER_HOST_UNAVAILABLE');

    await sweepAutomaticReleases(new Date(), { host: host(HISTORY) });
    expect(await fx.holdOf(id)).toEqual(original);
  });

  it('names a repository that answered but could not place the commit, and gives the row it DID close no hold', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const closes = await marked(A);
    const unread = await marked(B);
    for (const id of [closes, unread]) await abortHold(id);
    const answers = host(HISTORY);
    const half = async () => {
      const h = (await answers()) as { compare: (b: string, h: string) => Promise<string> };
      return {
        ...h,
        compare: async (base: string, head: string) => {
          if (base === B) throw new Error('commit B could not be read');
          return h.compare(base, head);
        },
      } as never;
    };

    const result = await sweepAutomaticReleases(new Date(), { host: half });

    expect(result.shippedEarlier).toBe(1);
    expect((await runOf(closes))?.status).toBe('closed');
    expect(await fx.holdOf(closes)).toBeNull();
    const held = await fx.holdOf(unread);
    expect(held?.code).toBe('RELEASE_ABORT_BLOCKED');
    expect(held?.reason).toContain('SHIPPED_EARLIER_UNREAD');
    expect(held?.reason).toContain('commit B could not be read');
  });

  it('puts the clause on whatever hold a row that no abort holds is given', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(N);

    await sweepAutomaticReleases(new Date());

    const held = await fx.holdOf(id);
    expect(held).not.toBeNull();
    expect(held?.code).not.toBe('RELEASE_ABORT_BLOCKED');
    expect(held?.reason).toContain('SHIPPED_EARLIER_HOST_UNAVAILABLE');
  });
});
