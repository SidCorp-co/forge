/**
 * forge-core-61 — `GET /api/issues/:id/criteria` carries each criterion's standing as the gate that
 * will decide the issue weighs it. Planted from adminhub-api on 2026-10-30: work lands on
 * `release/stg` and a promotion carries it to `release/production`; ISS-90 merged as 6bcfb9cb with
 * runtime verdicts at 6bcfb9cb on `stg`, which serves its descendant 0076d673. The read said nothing
 * about whether those verdicts count, so its master could not tell. A promotion project weighs at
 * the landing; an on-land one at what is served; an unreleased issue on the environment it is judged
 * on. Through the app's own route, against real Postgres, with the probes' answers and the source
 * host's compares stubbed.
 *
 * @direct-test-of packages/core/src/release-batch/criteria-weighing.ts
 * @direct-test-of packages/core/src/issues/criteria-weighing.ts
 * @direct-test-of packages/core/src/issues/criteria/service.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { READ_PATH_HELD_ONLY, readWeighingNow } from '../../src/release-batch/runtime-weighing.js';
import { readServingNow } from '../../src/release-batch/serving-reading.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** The source host as it answers, counting every call: each ancestor is behind what stg serves. */
const H = vi.hoisted(() => {
  const ancestor = '6bcfb9cb54a6ac89724a10f9f304671869c7bed7';
  const earlier = 'b14461ec9a6ac89724a10f9f304671869c7bed70';
  const unasked = 'c0ffee0e9a6ac89724a10f9f304671869c7bed70';
  const asked = { calls: 0 };
  const files = { files: ['app/Http/Kernel.php'], changes: [] };
  return {
    ancestor,
    earlier,
    unasked,
    asked,
    host: {
      fullName: 'sidcorp-it/canawan-api',
      compare: async (base: string) => {
        asked.calls += 1;
        return [ancestor, earlier, unasked].includes(base) ? 'ahead' : 'diverged';
      },
      compareFiles: async () => {
        asked.calls += 1;
        return { status: 'diverged', ...files };
      },
      commitFiles: async () => {
        asked.calls += 1;
        return files;
      },
    },
  };
});

vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => H.host,
}));

const STG_PROBE = 'https://stg-adminhub-api.example.test/api/v1/build-info';
const PRODUCTION_PROBE = 'https://adminhub-api.example.test/api/v1/build-info';
/** What `stg` serves: a descendant of the landing, as 0076d673 was of 6bcfb9cb. */
const SERVED = '0076d673515fdb24a01de5af5d8ab1e448c156aa';
const LANDING = H.ancestor;
const UNRELATED = '9a258402c0ffee00c0ffee00c0ffee00c0ffee00';

let projectId: string;
let ownerId: string;
let token: string;

const probeOn = (url: string) => ({
  runtime: [{ type: 'http' as const, url, path: 'commit', identifies: 'source' as const }],
});

const stg = (deploysFrom: string) => ({
  tier: 'staging' as const,
  deploysFrom,
  deployment: { mode: 'external' as const },
  url: 'https://stg-adminhub-api.example.test',
  verification: probeOn(STG_PROBE),
});

const delivery = (judgedOn: string | null) => ({
  delivery: { verdictsRequired: true, ...(judgedOn ? { judgedOn } : {}) },
});

/** adminhub-api's document: lands on `release/stg`, promoted to `release/production` by merge. */
async function promotionProject(): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch: 'release/stg',
    promotions: [{ from: 'release/stg', to: 'release/production', via: 'merge' }],
    environments: {
      stg: stg('release/stg'),
      production: {
        tier: 'production',
        deploysFrom: 'release/production',
        deployment: { mode: 'external' },
        url: 'https://adminhub-api.example.test',
      },
    } as never,
    extra: {
      release: { approval: { required: true }, changeRequests: false },
      ...delivery('stg'),
    } as never,
  });
}

/** Lands on `main`, which production deploys on land: no promotion stands between. */
async function onLandProject(judgedOn: string | null): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      stg: stg('main'),
      production: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { binding: randomUUID(), trigger: 'on-land' },
      },
    } as never,
    extra: delivery(judgedOn) as never,
  });
}

/** Lands on `main`, which production deploys outside Forge, and production answers a probe. */
async function externalProject(judgedOn: string | null): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      stg: stg('main'),
      production: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
        url: 'https://adminhub-api.example.test',
        verification: probeOn(PRODUCTION_PROBE),
      },
    } as never,
    extra: delivery(judgedOn) as never,
  });
}

let seq = 0;

/**
 * An issue merged as `LANDING` on `target`, waiting at `awaiting_release`, with one criterion per
 * verdict: a `pass` judged at `[kind, ref]` by the project's QA judge.
 */
async function landedIssue(
  target: string,
  verdicts: ReadonlyArray<readonly ['commit' | 'runtime', string]>,
): Promise<string> {
  seq += 1;
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, merged_target)
    VALUES (${projectId}, ${seq}, ${`ISS-${seq}`}, 'in_progress', ${ownerId}, now(), ${LANDING},
            ${target})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = (row as { id: string }).id;
  await replaceCriteria(
    id,
    verdicts.map((_, i) => ({ n: i + 1, statement: `Criterion ${i + 1} holds on stg.` })),
  );
  for (const [i, [kind, ref]] of verdicts.entries()) {
    const commit = kind === 'commit' ? ref : null;
    const runtime = kind === 'runtime' ? ref : null;
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind,
                                      commit_sha, runtime_ref, author_user_id, author_agency, judge)
      SELECT id, ${id}, 'pass', 'Called the route on stg.', ${kind}, ${commit}, ${runtime},
             ${ownerId}, 'agent', 'qa'
        FROM issue_criteria WHERE issue_id = ${id} AND n = ${i + 1} AND retired_at IS NULL
    `);
  }
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

interface Weighing {
  earned: boolean | null;
  standing: string | null;
  reason: string;
  weighedOn: Record<string, unknown>;
}

/** Each live criterion's `weighing`, by its number, as the criteria read answers it. */
async function weighed(issueId: string): Promise<Map<number, Weighing>> {
  const res = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const criteria = res.body.criteria as Array<{ n: number; latest: unknown; weighing?: Weighing }>;
  // the read's existing fields stay as they were: a verdict on every criterion here
  for (const c of criteria) expect(c.latest).not.toBeNull();
  return new Map(
    criteria.map((c) => {
      if (!c.weighing) throw new Error(`criterion ${c.n} carries no weighing`);
      return [c.n, c.weighing];
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(STG_PROBE) || url.startsWith(PRODUCTION_PROBE)) {
      return Response.json({ commit: SERVED });
    }
    return real(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a promotion project: the criteria read weighs at the landing (adminhub-api ISS-90)', () => {
  it('reads runtime verdicts at the landing on stg as earned there, and one elsewhere as not', async () => {
    await promotionProject();
    const id = await landedIssue('release/stg', [
      ['commit', LANDING],
      ['runtime', LANDING],
      ['runtime', UNRELATED],
    ]);

    const read = await weighed(id);

    const landing = {
      basis: 'landing',
      landing: LANDING,
      landsOn: 'release/stg',
      deploysFrom: 'release/production',
    };
    expect(read.get(1)).toMatchObject({ earned: true, standing: 'stands', weighedOn: landing });
    expect(read.get(2)).toMatchObject({ earned: true, standing: 'stands', weighedOn: landing });
    expect(read.get(2)?.reason).toBe(
      `judged at the landing commit \`${LANDING.slice(0, 12)}\` on \`release/stg\`, which counts there`,
    );
    expect(read.get(3)).toMatchObject({ earned: false, standing: null, weighedOn: landing });
    expect(read.get(3)?.reason).toContain(`\`${UNRELATED.slice(0, 12)}\``);
    expect(read.get(3)?.reason).toContain('so a criterion is earned at the landing');
  });
});

describe('an on-land project: the criteria read weighs at what is served', () => {
  it('carries a runtime verdict at an ancestor of what stg serves once a release pass read it, naming stg', async () => {
    await onLandProject('stg');
    const id = await landedIssue('main', [
      ['runtime', H.earlier],
      ['runtime', UNRELATED],
    ]);
    const onStg = { basis: 'served', environment: 'stg', runtime: null };

    // a read asks the source host nothing (ISS-774): before any release pass, nothing on record
    // answers whether stg's commit carries it, which is unknown, never not carried
    const asked = H.asked.calls;
    const before = await weighed(id);
    expect(H.asked.calls).toBe(asked);
    expect(before.get(1)).toMatchObject({ earned: null, standing: 'unread', weighedOn: onStg });
    expect(before.get(1)?.reason).toContain(READ_PATH_HELD_ONLY);

    // the release sweep's own pass reads the host, as `release-sweep.ts:readCriteria` does
    await readWeighingNow(projectId, await readServingNow(projectId), [id]);
    expect(H.asked.calls).toBeGreaterThan(asked);

    const read = await weighed(id);
    expect(read.get(1)).toMatchObject({ earned: true, standing: 'carried', weighedOn: onStg });
    expect(read.get(1)?.reason).toBe(
      `judged at ${H.earlier}, which is not a commit \`stg\`, the environment this project judges a change on until it is released, is serving, and what it serves carries it: \`${SERVED}\` descends from it`,
    );
    expect(read.get(2)).toMatchObject({ earned: false, standing: 'superseded', weighedOn: onStg });
    expect(read.get(2)?.reason).toContain(`judged at ${UNRELATED}, which is not a commit \`stg\``);
  });
});

describe('an unreleased issue: the criteria read weighs on the environment it is judged on', () => {
  it('weighs on stg until released, then on production', async () => {
    await externalProject('stg');
    const id = await landedIssue('main', [['runtime', SERVED]]);

    const waiting = await weighed(id);
    expect(waiting.get(1)).toMatchObject({
      earned: true,
      standing: 'stands',
      weighedOn: { basis: 'served', environment: 'stg', runtime: null },
    });
    expect(waiting.get(1)?.reason).toContain(`judged at ${SERVED}, which \`stg\``);

    await seedIssueStatus(id, 'closed');
    const released = await weighed(id);
    expect(released.get(1)).toMatchObject({
      earned: true,
      standing: 'stands',
      weighedOn: { basis: 'served', environment: null, runtime: null },
    });
    expect(released.get(1)?.reason).toBe(`judged at ${SERVED}, which this project is serving`);
  });

  it('keeps production where no judged-on environment is named, and says so', async () => {
    await externalProject(null);
    const id = await landedIssue('main', [['runtime', UNRELATED]]);

    const read = await weighed(id);

    expect(read.get(1)).toMatchObject({
      earned: false,
      standing: 'superseded',
      weighedOn: { basis: 'served', environment: null, runtime: null },
    });
    expect(read.get(1)?.reason).toContain('so it is weighed against production');
  });
});

describe('where no basis can be computed, every criterion says why', () => {
  it('names the unread release path on each criterion of a project with no document', async () => {
    const id = await landedIssue('main', [
      ['runtime', LANDING],
      ['commit', LANDING],
    ]);

    const read = await weighed(id);

    for (const n of [1, 2]) {
      expect(read.get(n)).toMatchObject({
        earned: null,
        standing: null,
        weighedOn: { basis: 'none' },
      });
      expect(read.get(n)?.reason).toMatch(
        /^where this project's criteria are earned could not be read: /,
      );
    }
  });
});

describe('release readiness, a read too, asks the source host nothing (ISS-774)', () => {
  it('weighs a waiting runtime verdict no release pass has read without a compare', async () => {
    await onLandProject('stg');
    await landedIssue('main', [['runtime', H.unasked]]);
    const asked = H.asked.calls;

    const res = await api(token, 'GET', `/api/projects/${projectId}/release-readiness`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(H.asked.calls).toBe(asked);
  });
});
