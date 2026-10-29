/**
 * ISS-774 case 2 (owner, 2026-10-29: Forge tells the agent what is owed and the agent records it).
 * An issue landed before a release was cut and was marked merged only after it, so that release never
 * claimed it. Forge used to settle that itself, asking the repository on every sweep and cut which
 * shipped release held the landing and closing the issue into it (the removed `shipped-earlier.ts`, 129
 * closes on dev in October). Now the sweep and the cut ask nothing and close nothing: the issue is held naming
 * the act its agent owes, and the agent's record of the release, read with its own git, closes it.
 * Against real Postgres, with a planted host that counts every call it is asked.
 *
 * @direct-test-of packages/core/src/release-batch/shipped-in.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { A, C1, C2, markTrailWorld } from '../helpers/mark-trail-world.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';

const planted = vi.hoisted(() => ({ calls: 0 }));

// Every commit is in every release: were Forge to ask, it would close the issue into the first.
vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    host: 'gitlab.com',
    provider: 'gitlab',
    fullName: 'acme/app',
    compare: async () => {
      planted.calls += 1;
      return 'ahead';
    },
    branchHead: async () => C2,
    readRange: async () => {
      planted.calls += 1;
      return { ok: true, complete: true, commits: [] };
    },
  }),
}));

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { claim } = markTrailWorld();

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
  planted.calls = 0;
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** A release that shipped, cut `cutAgo` minutes ago, verified serving `commit`. */
async function shipped(version: string, commit: string, cutAgo: number): Promise<string> {
  const id = randomUUID();
  const at = minutesAgo(cutAgo);
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, created_at, release_version,
                               release_released_at, metadata)
    VALUES (${id}, ${projectId}, 'system', 'completed', ${at}::timestamptz, ${at}::timestamptz,
            ${version}, ${at}::timestamptz,
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: randomUUID(), state: 'finished', commit, version: 1 } })}::jsonb)
  `);
  return id;
}

/** An issue at the gate that landed `landedAgo` minutes ago and was marked merged just now. */
async function markedLate(landedAgo: number): Promise<string> {
  const id = await fx.insertIssue('awaiting_release');
  await db.execute(
    sql`UPDATE issues SET merged_commit_sha = ${A}, merged_at = ${minutesAgo(landedAgo)}::timestamptz WHERE id = ${id}`,
  );
  await claim(id, A);
  return id;
}

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const record = (body: Record<string, unknown>) =>
  api(token, 'POST', `/api/projects/${projectId}/shipped-in-records`, body);

describe('an issue marked after a release that may hold it was cut', () => {
  it('is held for its agent by the sweep, asking the repository nothing and closing nothing', async () => {
    await shipped('0.4.0-dev.1', C1, 60);
    const id = await markedLate(120);

    await sweepAutomaticReleases();

    expect(planted.calls, 'calls the sweep made to the source host').toBe(0);
    expect(await statusOf(id)).toBe('awaiting_release');
    expect(await fx.holdOf(id)).toMatchObject({
      code: 'RELEASE_SHIPPED_IN_OWED',
      owes: 'agent',
    });
    expect((await fx.holdOf(id))?.reason).toContain('0.4.0-dev.1');
    expect((await fx.holdOf(id))?.reason).toContain(A);
  });

  it('is named at the release gate, so no cut carries it while its agent owes the record', async () => {
    await shipped('0.4.0-dev.1', C1, 60);
    const id = await markedLate(120);

    const readiness = await api(token, 'GET', `/api/projects/${projectId}/release-readiness`);
    expect(readiness.status).toBe(200);
    expect(JSON.stringify(readiness.body)).toContain('RELEASE_SHIPPED_IN_OWED');
    const cut = await api(token, 'POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [id],
    });
    expect(JSON.stringify(cut.body)).toContain('RELEASE_SHIPPED_IN_OWED');
    expect(await statusOf(id)).toBe('awaiting_release');
    expect(planted.calls).toBe(0);
  });

  it('owes nothing where the mark came before the cut, or the landing after it', async () => {
    await shipped('0.4.0-dev.1', C1, 60);
    const landedAfter = await markedLate(30);
    await sweepAutomaticReleases();
    expect((await fx.holdOf(landedAfter))?.code).not.toBe('RELEASE_SHIPPED_IN_OWED');
  });
});

describe("the agent's record of the release that shipped it", () => {
  it('closes the issue into the release it names, as that release finishing would have', async () => {
    const run = await shipped('0.4.0-dev.1', C1, 60);
    const id = await markedLate(120);
    await sweepAutomaticReleases();

    const sent = await record({
      issueId: id,
      version: '0.4.0-dev.1',
      evidence: `git merge-base --is-ancestor ${A} ${C1} answered 0`,
    });

    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ version: '0.4.0-dev.1', runId: run, closed: true });
    expect(await statusOf(id)).toBe('closed');
    expect(await fx.holdOf(id)).toBeNull();
    const [meta] = await rows<{ closed: string[] }>(
      sql`SELECT metadata -> 'rosterClosed' AS closed FROM pipeline_runs WHERE id = ${run}`,
    );
    expect(meta?.closed).toEqual([id]);
    expect(planted.calls).toBe(0);
  });

  // ISS-759: the old placement credited an earlier release that did not carry the issue
  it('refuses by name a release cut before the issue landed, which cannot hold it', async () => {
    await shipped('0.4.0-dev.1', C1, 180);
    await shipped('0.4.0-dev.2', C2, 60);
    const id = await markedLate(120);

    const early = await record({
      issueId: id,
      version: '0.4.0-dev.1',
      evidence: 'the subject of an older commit names it',
    });
    expect(early.status).toBe(422);
    expect(JSON.stringify(early.body)).toContain('RELEASE_SHIPPED_IN_BEFORE_LANDING');
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('refuses a version no release of this project shipped', async () => {
    await shipped('0.4.0-dev.1', C1, 60);
    const id = await markedLate(120);
    const unknown = await record({ issueId: id, version: '9.9.9', evidence: 'git log says so' });
    expect(JSON.stringify(unknown.body)).toContain('RELEASE_SHIPPED_IN_UNKNOWN');
  });

  it('takes `none`: the hold goes, and the next sweep no longer owes it', async () => {
    await shipped('0.4.0-dev.1', C1, 60);
    const id = await markedLate(120);
    await sweepAutomaticReleases();

    const none = await record({
      issueId: id,
      version: null,
      evidence: `git merge-base --is-ancestor ${A} ${C1} answered 1`,
    });
    expect(none.status, JSON.stringify(none.body)).toBe(201);
    expect(none.body).toMatchObject({ version: null, closed: false });
    await sweepAutomaticReleases();
    expect((await fx.holdOf(id))?.code).not.toBe('RELEASE_SHIPPED_IN_OWED');
    expect(await statusOf(id)).toBe('awaiting_release');
  });
});

// dev, 2026-10-29: ISS-767 and ISS-768 were marked with a commit and answered 200 "recorded here as
// this call's claim", then read back `mergedCommitSha: null`, so the master read them as naming none
describe('the commit an agent states on its mark', () => {
  it('reads back on the issue as stated, with its provenance', async () => {
    await shipped('0.4.0-dev.1', C1, 60);
    const id = await fx.insertIssue('in_progress', undefined, false);
    await db.execute(
      sql`UPDATE issues SET merged_at = NULL, merged_commit_sha = NULL WHERE id = ${id}`,
    );
    const marked = await api(token, 'POST', `/api/issues/${id}/merge`, {
      target: 'main',
      commit: A,
      note: 'landed on main by a direct push, no change request',
    });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);

    const read = await api(token, 'GET', `/api/issues/${id}`);
    expect(read.status).toBe(200);
    expect((read.body as { markedCommit?: unknown }).markedCommit).toEqual({
      sha: A,
      provenance: 'asserted',
    });
  });
});
