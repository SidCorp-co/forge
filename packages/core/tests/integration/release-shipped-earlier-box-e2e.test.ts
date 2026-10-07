/**
 * A project with no source host binding: whether an issue's commit is in a release that shipped is
 * asked of the box holding the project's bound checkout (`runners/checkout-ancestry.ts`), and the
 * answer closes the row through the same release path as a host's (`release-batch/shipped-earlier.ts`).
 * Against real Postgres and the real binding query, with the box's socket stood in for: what is
 * asserted is which box was asked, and what the rows, holds and notices hold afterwards.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { SourceHostUnavailable } from '../../src/integrations/source-host/index.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import {
  closeShippedEarlier,
  type ShippedEarlierDeps,
} from '../../src/release-batch/shipped-earlier.js';
import { answerCheckoutAncestry, forgetSilentBoxes } from '../../src/runners/index.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';
import { A, C1, C2, HISTORY, N, shippedEarlierWorld } from '../helpers/shipped-earlier-world.js';

let projectId: string;
let ownerId: string;
let ours: string;
let theirs: string;
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
  forgetSilentBoxes();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
  ours = await createTestDevice(ownerId, { name: 'ours' });
  await bindTestRunner(projectId, ours);
  // A box that reaches another project only, connected and willing to answer anything.
  theirs = await createTestDevice(ownerId, { name: 'theirs' });
  await bindTestRunner((await createTestProject(ownerId)).id, theirs);
});

const ORIGIN = 'https://github.com/acme/test-project.git';
type Mode = 'history' | 'unreadable' | 'refuses';

/** The box's socket: records who was asked, and answers as a checkout holding `HISTORY` would. */
function box(mode: Mode, online: (deviceId: string) => boolean = () => true) {
  const asked: string[] = [];
  const deps: ShippedEarlierDeps = {
    host: async () => {
      throw new SourceHostUnavailable(
        'no_binding',
        'this project has no active source host binding',
      );
    },
    box: {
      listening: online,
      timeoutMs: 500,
      send: (deviceId, envelope) => {
        asked.push(deviceId);
        const { requestId, pairs } = envelope.data as {
          requestId: string;
          pairs: { commit: string; release: string }[];
        };
        queueMicrotask(() => {
          answerCheckoutAncestry(
            deviceId,
            requestId,
            mode === 'refuses'
              ? { projectId, error: 'the bound checkout /srv/checkout is not a git work tree' }
              : {
                  projectId,
                  origin: ORIGIN,
                  readAt: '2026-10-07T10:00:00Z',
                  via: 'runner-checkout',
                  fetched: true,
                  answers: pairs.map((p) =>
                    mode === 'unreadable'
                      ? { ...p, error: `the checkout /srv/checkout holds no commit ${p.commit}` }
                      : { ...p, ancestor: (HISTORY[p.release] ?? []).includes(p.commit) },
                  ),
                },
          );
        });
        return 1;
      },
    },
  };
  return { asked, deps };
}

async function lastComment(id: string): Promise<string | undefined> {
  const [row] = await rows<{ body: string }>(sql`
    SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at DESC LIMIT 1
  `);
  return row?.body;
}

async function rosterClosedOf(runId: string): Promise<string[]> {
  const [row] = await rows<{ closed: string[] | null }>(sql`
    SELECT metadata -> 'rosterClosed' AS closed FROM pipeline_runs WHERE id = ${runId}
  `);
  return row?.closed ?? [];
}

describe('a box holding the bound checkout answers where no source host can', () => {
  it('closes a row against the EARLIEST verified release holding its commit, naming the box-read evidence', async () => {
    const first = await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    await shipped('0.4.0-dev.2', C2, '2026-10-06T11:00:00Z');
    const id = await marked(A);
    await abortHold(id);
    const { asked, deps } = box('history');

    const result = await closeShippedEarlier({ projectId, issueIds: [id], userId: ownerId }, deps);

    expect(result.unresolved).toEqual([]);
    expect(result.closed.map((c) => [c.issueId, c.version])).toEqual([[id, '0.4.0-dev.1']]);
    expect(result.closed[0]?.witness).toMatchObject({
      via: 'box-read',
      deviceId: ours,
      repoPath: '/srv/checkout',
      commit: A,
      release: C1,
    });
    expect(await runOf(id)).toEqual({ status: 'closed', claim: null });
    expect(await rosterClosedOf(first)).toEqual([id]);
    expect(await fx.holdOf(id)).toBeNull();
    const notice = await lastComment(id);
    expect(notice).toContain('Shipped in 0.4.0-dev.1');
    expect(notice).toContain(`box-read evidence: box ${ours}, checkout /srv/checkout`);
    expect(notice).toContain(`git merge-base --is-ancestor ${A} ${C1}`);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((d) => d === ours)).toBe(true);
  });

  it('asks the commit an asserted mark claimed, and closes on the box answering yes', async () => {
    const first = await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await asserted();
    await claim(id, A);

    const result = await closeShippedEarlier(
      { projectId, issueIds: [id], userId: ownerId },
      box('history').deps,
    );

    expect(result.closed.map((c) => c.version)).toEqual(['0.4.0-dev.1']);
    expect(await rosterClosedOf(first)).toEqual([id]);
    expect(await lastComment(id)).toContain('the commit its mark claimed');
  });

  it('leaves a row the box says no release holds untouched: not closed, not claimed, abort hold kept', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(N);
    await abortHold(id);

    const result = await sweepAutomaticReleases(new Date(), box('history').deps);

    expect(result.shippedEarlier).toBe(0);
    expect(await runOf(id)).toEqual({ status: 'awaiting_release', claim: null });
    const held = await fx.holdOf(id);
    expect(held?.code).toBe('RELEASE_ABORT_BLOCKED');
    expect(held?.reason).not.toContain('could not settle');
  });

  it('names a box that answered it could not read the commit on the row, and moves nothing', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);
    await abortHold(id);

    await sweepAutomaticReleases(new Date(), box('unreadable').deps);

    expect(await runOf(id)).toEqual({ status: 'awaiting_release', claim: null });
    const held = await fx.holdOf(id);
    expect(held?.code).toBe('RELEASE_ABORT_BLOCKED');
    expect(held?.reason).toContain('(SHIPPED_EARLIER_UNREAD)');
    expect(held?.reason).toContain(
      `the box ${ours} could not read it in its checkout /srv/checkout`,
    );
  });

  it('names a box that refused the whole read as unread, never as no host', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);

    const result = await closeShippedEarlier(
      { projectId, issueIds: [id], userId: ownerId },
      box('refuses').deps,
    );

    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_UNREAD']);
    expect(result.unresolved[0]?.detail).toContain('not a git work tree');
  });
});

describe("with no box answering, today's refusal stands by name", () => {
  it('is SHIPPED_EARLIER_HOST_UNAVAILABLE where the bound box is not connected, naming both', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);
    const { asked, deps } = box('history', (d) => d !== ours);

    const result = await closeShippedEarlier({ projectId, issueIds: [id], userId: ownerId }, deps);

    expect(asked).toEqual([]);
    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_HOST_UNAVAILABLE']);
    expect(result.unresolved[0]?.detail).toContain('no active source host binding');
    expect(result.unresolved[0]?.detail).toContain(
      'no box holding a checkout bound to this project is connected',
    );
    expect(await runOf(id)).toEqual({ status: 'awaiting_release', claim: null });
  });

  it('never asks a box that reaches another project only, however willing', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);
    await db.execute(sql`DELETE FROM runners WHERE device_id = ${ours}`);
    const { asked, deps } = box('history');

    const result = await closeShippedEarlier({ projectId, issueIds: [id], userId: ownerId }, deps);

    expect(asked).not.toContain(theirs);
    expect(asked).toEqual([]);
    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_HOST_UNAVAILABLE']);
    expect(result.unresolved[0]?.detail).toContain(
      'no runner holds a checkout bound to this project',
    );
  });

  it('keeps an asserted mark that claimed no commit host-only, and says why', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await asserted();
    const { asked, deps } = box('history');

    const result = await closeShippedEarlier({ projectId, issueIds: [id], userId: ownerId }, deps);

    expect(asked).toEqual([]);
    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_NO_COMMIT']);
    expect(result.unresolved[0]?.detail).toContain('which only a source host reads');
  });

  it('offers no box on the hold of a row no box can place, and a way out that can happen', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const bare = await asserted();
    const claimed = await asserted();
    await claim(claimed, N);

    await sweepAutomaticReleases(new Date(), box('history').deps);

    const held = await fx.holdOf(bare);
    expect(held?.reason).toContain('(SHIPPED_EARLIER_NO_COMMIT)');
    expect(held?.waitingFor).toContain('source host binding');
    expect(held?.waitingFor).toContain('naming the commit that landed it');
    expect(held?.waitingFor).not.toContain('box');
    expect(held?.reason).not.toContain('connected box holding');
    expect((await fx.holdOf(claimed))?.reason ?? '').not.toContain('SHIPPED_EARLIER_NO_COMMIT');
  });

  it('keeps the box as a way out for rows that name a commit, where no box is connected', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const bare = await asserted();
    const claimed = await asserted();
    await claim(claimed, A);

    await sweepAutomaticReleases(new Date(), box('history', (d) => d !== ours).deps);

    for (const id of [bare, claimed]) {
      const held = await fx.holdOf(id);
      expect(held?.reason).toContain('(SHIPPED_EARLIER_HOST_UNAVAILABLE)');
      expect(held?.waitingFor).toContain('a connected box holding a bound checkout');
    }
  });
});
