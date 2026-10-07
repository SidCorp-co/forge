/**
 * An issue at `awaiting_release` whose landing commit an earlier release already shipped is closed
 * against that release, not held for a person (`release-batch/shipped-earlier.ts`). Against real
 * Postgres, with the repository's ancestry answered by a fake host: what is asserted is what the
 * rows, the holds and the release record hold afterwards.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { SourceHostUnavailable } from '../../src/integrations/source-host/index.js';
import { createReleaseBatch } from '../../src/release-batch/create.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeShippedEarlier } from '../../src/release-batch/shipped-earlier.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';
import {
  A,
  B,
  C1,
  C2,
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

const subjectFor = async (id: string, what = 'the work') => {
  const [key] = await fx.displayIds([id]);
  return `${key}: ${what}`;
};

async function rosterClosedOf(runId: string): Promise<string[]> {
  const [row] = await rows<{ closed: string[] | null }>(sql`
    SELECT metadata -> 'rosterClosed' AS closed FROM pipeline_runs WHERE id = ${runId}
  `);
  return row?.closed ?? [];
}

const close = (ids: string[], h = host(HISTORY)) =>
  closeShippedEarlier({ projectId, issueIds: ids, userId: ownerId }, { host: h });

describe('closing against the release that shipped the commit', () => {
  it('closes each issue against the EARLIEST release holding its commit, and records it there', async () => {
    const first = await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const second = await shipped('0.4.0-dev.2', C2, '2026-10-06T11:00:00Z');
    const inFirst = await marked(A);
    const inSecond = await marked(B);

    const result = await close([inFirst, inSecond]);

    expect(result.unresolved).toEqual([]);
    expect(result.closed.map((c) => [c.issueId, c.version]).sort()).toEqual(
      [
        [inFirst, '0.4.0-dev.1'],
        [inSecond, '0.4.0-dev.2'],
      ].sort(),
    );
    expect((await runOf(inFirst))?.status).toBe('closed');
    expect((await runOf(inSecond))?.status).toBe('closed');
    expect((await runOf(inFirst))?.claim).toBeNull();
    expect(await rosterClosedOf(first)).toEqual([inFirst]);
    expect(await rosterClosedOf(second)).toEqual([inSecond]);
  });

  it('clears the hold an aborted release left on a row it closes, and says why on the issue', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);
    await abortHold(id);
    expect(await fx.holdOf(id)).not.toBeNull();

    const result = await close([id]);

    expect(result.unresolved).toEqual([]);
    expect(await fx.holdOf(id)).toBeNull();
    const [comment] = await rows<{ body: string }>(sql`
      SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at DESC LIMIT 1
    `);
    expect(comment?.body).toContain('Shipped in 0.4.0-dev.1');
  });

  it('leaves a commit no release holds for a normal claim: not closed, not claimed, not held', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(N);

    const result = await close([id]);

    expect(result).toEqual({ closed: [], unresolved: [] });
    expect(await runOf(id)).toEqual({ status: 'awaiting_release', claim: null });
  });

  it('does not count a release that never shipped', async () => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
      VALUES (${id}, ${projectId}, 'system', 'running', now(), '0.4.0-dev.1',
              ${JSON.stringify({ source: 'release-batch', finish: { state: 'verifying', commit: C1 } })}::jsonb)
    `);
    const issue = await marked(A);

    expect(await close([issue])).toEqual({ closed: [], unresolved: [] });
  });
});

describe('what the repository cannot answer is refused by name and moves nothing', () => {
  it('names a repository that cannot be read, and leaves the row and its hold as they were', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);
    await abortHold(id);

    const result = await closeShippedEarlier(
      { projectId, issueIds: [id], userId: ownerId },
      {
        host: async () => {
          throw new SourceHostUnavailable('no_binding', 'the project has no repository binding');
        },
      },
    );

    expect(result.closed).toEqual([]);
    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_HOST_UNAVAILABLE']);
    expect(result.unresolved[0]?.detail).toContain('no repository binding');
    expect((await runOf(id))?.status).toBe('awaiting_release');
    expect((await fx.holdOf(id))?.code).toBe('RELEASE_ABORT_BLOCKED');
  });

  it('names a commit the repository would not place, and never infers a version', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);

    const result = await close([id], host(HISTORY, { fail: 'rate limited' }));

    expect(result.closed).toEqual([]);
    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_UNREAD']);
    expect(result.unresolved[0]?.detail).toContain('rate limited');
    expect((await runOf(id))?.status).toBe('awaiting_release');
  });
});

describe('the sweep reads a held row again (the live shape: ten rows, one release, held for a person)', () => {
  it('closes rows held RELEASE_ABORT_BLOCKED whose commits are all shipped, and cuts nothing', async () => {
    const run = await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const held = [await marked(A), await marked(A)];
    for (const id of held) await abortHold(id);
    const [before] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pipeline_runs`);

    const result = await sweepAutomaticReleases(new Date(), { host: host(HISTORY) });

    expect(result.shippedEarlier).toBe(2);
    expect(result.projectsCut).toBe(0);
    for (const id of held) {
      expect((await runOf(id))?.status).toBe('closed');
      expect(await fx.holdOf(id)).toBeNull();
    }
    expect((await rosterClosedOf(run)).sort()).toEqual([...held].sort());
    const [after] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pipeline_runs`);
    expect(after?.n).toBe(before?.n);
  });

  it("keeps today's hold where the repository says the commit is not in any release", async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(N);
    await abortHold(id);

    const result = await sweepAutomaticReleases(new Date(), { host: host(HISTORY) });

    expect(result.shippedEarlier).toBe(0);
    expect((await runOf(id))?.status).toBe('awaiting_release');
    expect((await fx.holdOf(id))?.code).toBe('RELEASE_ABORT_BLOCKED');
  });
});

describe('a cut that names only shipped issues', () => {
  it('closes them against their release and refuses by name, cutting no release', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await marked(A);
    const [before] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pipeline_runs`);

    await expect(
      createReleaseBatch({ projectId, issueIds: [id], userId: ownerId }, { host: host(HISTORY) }),
    ).rejects.toThrow(`${id} in 0.4.0-dev.1`);

    expect((await runOf(id))?.status).toBe('closed');
    const [after] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pipeline_runs`);
    expect(after?.n).toBe(before?.n);
  });
});

describe('an asserted mark names no commit, so the commits declaring the issue are placed', () => {
  // A range between two commits is read once for the process, so each test cuts commits of its own.
  let RANGE_1 = '';
  let RANGE_2 = '';
  let UNRELEASED = '';
  let HEAD = '';

  async function threeReleases() {
    const [c1, c2, c3] = [randomUUID(), randomUUID(), randomUUID()].map((u) =>
      u.replaceAll('-', '').padEnd(40, '0'),
    ) as [string, string, string];
    RANGE_1 = `${c1}..${c2}`;
    RANGE_2 = `${c2}..${c3}`;
    UNRELEASED = `${c3}..${c3}`;
    HEAD = c3;
    await shipped('0.4.0-dev.1', c1, '2026-10-06T10:00:00Z');
    const second = await shipped('0.4.0-dev.2', c2, '2026-10-06T11:00:00Z');
    const third = await shipped('0.4.0-dev.3', c3, '2026-10-06T12:00:00Z');
    return { second, third };
  }

  it('closes it against the release whose range holds its last declaring commit', async () => {
    const { second, third } = await threeReleases();
    const id = await asserted();
    const other = await asserted();
    const ranges = {
      [RANGE_1]: [await subjectFor(id, 'first half')],
      [RANGE_2]: [await subjectFor(other)],
    };

    const result = await close([id, other], host(HISTORY, { head: HEAD, ranges }));

    expect(result.unresolved).toEqual([]);
    expect(result.closed.map((c) => [c.issueId, c.version]).sort()).toEqual(
      [
        [id, '0.4.0-dev.2'],
        [other, '0.4.0-dev.3'],
      ].sort(),
    );
    expect(await rosterClosedOf(second)).toEqual([id]);
    expect(await rosterClosedOf(third)).toEqual([other]);
  });

  it('clears the hold an aborted release left on it', async () => {
    await threeReleases();
    const id = await asserted();
    await abortHold(id);

    await close([id], host(HISTORY, { head: HEAD, ranges: { [RANGE_2]: [await subjectFor(id)] } }));

    expect((await runOf(id))?.status).toBe('closed');
    expect(await fx.holdOf(id)).toBeNull();
  });

  it('leaves it alone while a commit declaring it is still unreleased', async () => {
    await threeReleases();
    const id = await asserted();
    const ranges = {
      [RANGE_1]: [await subjectFor(id)],
      [UNRELEASED]: [await subjectFor(id, 'more')],
    };

    const result = await close([id], host(HISTORY, { head: HEAD, ranges }));

    expect(result).toEqual({ closed: [], unresolved: [] });
    expect((await runOf(id))?.status).toBe('awaiting_release');
  });

  it('leaves it alone where no range declares it', async () => {
    await threeReleases();
    const id = await asserted();

    expect(await close([id], host(HISTORY, { head: HEAD }))).toEqual({
      closed: [],
      unresolved: [],
    });
    expect((await runOf(id))?.status).toBe('awaiting_release');
  });

  it('refuses by name a range the repository cannot give whole, and moves nothing', async () => {
    await threeReleases();
    const id = await asserted();
    await abortHold(id);
    const ranges = { [RANGE_1]: [await subjectFor(id)] };

    const result = await close([id], host(HISTORY, { head: HEAD, ranges, incomplete: true }));

    expect(result.closed).toEqual([]);
    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_UNREAD']);
    expect(result.unresolved[0]?.detail).toContain('unplaced');
    expect((await runOf(id))?.status).toBe('awaiting_release');
    expect((await fx.holdOf(id))?.code).toBe('RELEASE_ABORT_BLOCKED');
  });

  it('is the shape live on dev: rows held for a person, closed by the sweep with no act', async () => {
    const { third } = await threeReleases();
    const held = [await asserted(), await asserted()];
    for (const id of held) await abortHold(id);
    const ranges = { [RANGE_2]: await Promise.all(held.map((id) => subjectFor(id))) };

    const result = await sweepAutomaticReleases(new Date(), {
      host: host(HISTORY, { head: HEAD, ranges }),
    });

    expect(result.shippedEarlier).toBe(2);
    for (const id of held) expect(await fx.holdOf(id)).toBeNull();
    expect((await rosterClosedOf(third)).sort()).toEqual([...held].sort());
  });
});

describe('an asserted mark that claimed a commit', () => {
  it('is closed against the earliest release holding the claimed commit, with no declaring subject', async () => {
    const first = await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    await shipped('0.4.0-dev.2', C2, '2026-10-06T11:00:00Z');
    const id = await asserted();
    await abortHold(id);
    await claim(id, A);

    const result = await close([id]);

    expect(result.closed.map((c) => c.version)).toEqual(['0.4.0-dev.1']);
    expect((await runOf(id))?.status).toBe('closed');
    expect(await fx.holdOf(id)).toBeNull();
    expect(await rosterClosedOf(first)).toEqual([id]);
  });

  it('stays held where the claimed commit is in no shipped release', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await asserted();
    await abortHold(id);
    await claim(id, N);

    expect(await close([id])).toEqual({ closed: [], unresolved: [] });
    expect((await runOf(id))?.status).toBe('awaiting_release');
    expect((await fx.holdOf(id))?.code).toBe('RELEASE_ABORT_BLOCKED');
  });

  it('is refused by name where the host cannot resolve the claimed commit', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const id = await asserted();
    await claim(id, A);

    const result = await close([id], host(HISTORY, { fail: 'no such commit' }));

    expect(result.unresolved.map((u) => u.code)).toEqual(['SHIPPED_EARLIER_UNREAD']);
    expect((await runOf(id))?.status).toBe('awaiting_release');
  });

  it('does not read a comment that is not the kernel audit shape, or a mark that did not stamp', async () => {
    await shipped('0.4.0-dev.1', C1, '2026-10-06T10:00:00Z');
    const prose = await asserted();
    await fx.postComment(prose, `I think commit=${A} shipped`);
    const unstamped = await asserted();
    await claim(unstamped, A, '\nNOT stamped by this call: merged_at was already set');

    expect(await close([prose, unstamped])).toEqual({ closed: [], unresolved: [] });
  });
});
