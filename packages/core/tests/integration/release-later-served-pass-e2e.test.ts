/**
 * ISS-1290: on forge-dev every push deploys, so a judge sent for 0.4.0-dev.716 (eff4f0b5) found
 * 0.4.0-dev.717 (4198c1a6) served and recorded its pass there. 4198c1a6 descends from eff4f0b5 and its
 * commits touch none of the issue's files, yet `GET releases/0.4.0-dev.716` read 0 of 33 proven: a
 * commit pass counted only at the release's own build. Against real Postgres: two shipped releases
 * with their kept ranges, the issue on the first by its roster, judged at the second's commit.
 *
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-batch/served-carriage.ts
 * @direct-test-of packages/core/src/release-batch/criterion-reading.ts
 * @direct-test-of packages/core/src/release-batch/served-over.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { BRANCH, landedIssue, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import { passedAt, shippedRun } from '../helpers/shipped-commit-world.js';

const BASE = '565075a0fcdee6efd1df7975d376f58269f5f746';
const HEAD = 'eff4f0b5e47ad307061b79258a484667b9fdcedd';
const LIVE = '4198c1a695d5421815d2aa2281580d3c6ebbe39d';
const PROBE = 'https://forge-dev.example.test/api/version';
const FILE = 'packages/core/src/masters/owed-standings.ts';

const kept = (base: string, head: string, changed: string[], commits?: unknown[]) => ({
  range: {
    state: 'read',
    base,
    head,
    migrations: [],
    contracts: [],
    dependencies: [],
    settings: [],
    unchecked: null,
    changed: changed.map((path) => ({ path, change: 'changed' })),
    ...(commits ? { commits } : {}),
  },
});

beforeEach(async () => {
  await seedLandedWorld();
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: BRANCH,
    environments: {
      dev: {
        tier: 'production',
        deploysFrom: BRANCH,
        deployment: { mode: 'external' },
        url: 'https://forge-dev.example.test',
        verification: {
          runtime: [{ type: 'http', url: PROBE, path: 'commit', identifies: 'source' }],
        },
      },
    } as never,
    extra: { delivery: { verdictsRequired: false } } as never,
  });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PROBE)) return Response.json({ commit: LIVE });
    return real(input, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The issue shipped by dev.716, its range kept with or without commits, judged at dev.717's commit. */
async function judgedAtLater(commitsKept: boolean): Promise<Record<string, unknown>> {
  const issue = await landedIssue(1273, null);
  const key = `${(await api(world.token, 'GET', `/api/issues/${issue}`)).body.displayId}`;
  const other = await landedIssue(1280, null);
  const commits = [
    { sha: 'a'.repeat(40), subject: `fix(masters): a triage (${key})`, paths: [FILE] },
  ];
  const dev716 = await shippedRun(
    issue,
    {},
    {
      commit: HEAD,
      version: '0.4.0-dev.716',
      extra: kept(BASE, HEAD, [FILE, 'CHANGELOG.md'], commitsKept ? commits : undefined),
    },
  );
  const dev717 = await shippedRun(
    other,
    {},
    {
      commit: LIVE,
      version: '0.4.0-dev.717',
      extra: kept(HEAD, LIVE, ['packages/core/src/lessons/pass.ts']),
    },
  );
  // dev.716 shipped first
  await db.execute(sql`
    UPDATE pipeline_runs SET release_released_at = now() - interval '1 hour' WHERE id = ${dev716}`);
  await db.execute(sql`
    UPDATE pipeline_runs SET release_released_at = now() WHERE id = ${dev717}`);
  await seedIssueStatus(issue, 'closed');
  await passedAt(issue, LIVE);
  const res = await api(
    world.token,
    'GET',
    `/api/projects/${world.projectId}/releases/0.4.0-dev.716`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const release = res.body.release as {
    issueCriteria: {
      key: string;
      criteria: { n: number; proven: boolean; unverified: string | null }[];
    }[];
  };
  const criteria = release.issueCriteria.find((i) => i.key === key)?.criteria ?? [];
  return { c1: criteria.find((c) => c.n === 1), release: res.body.release, dev716 };
}

describe('a release counts a pass judged at a later served build carrying it (ISS-1290)', () => {
  it('reads it proven where the later build descends from its head and touches none of the issue files', async () => {
    const { c1, release } = await judgedAtLater(true);
    expect(
      c1,
      'ISS-1290: a pass at a later served build that carries the release unchanged counts on that release',
    ).toMatchObject({ proven: true, unverified: null });
    expect((release as { criteria: { proven: number } }).criteria.proven).toBe(1);
  });

  it('names what is missing where the release range kept no commits, never a silent unjudged', async () => {
    const { c1, dev716 } = await judgedAtLater(false);
    expect(c1).toMatchObject({ proven: false });
    expect((c1 as { unverified: string }).unverified).toContain(
      `\`forge-runner release range --project-id ${world.projectId}\` with \`--run ${dev716} --head ${HEAD}\``,
    );
  });
});
