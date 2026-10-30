/**
 * Until an issue's change is released, its runtime verdicts are weighed against the environment the
 * project judges its changes on (`delivery.judgedOn`), not production. Planted from adminhub-api's
 * environments on 2026-10-30: `stg` external, read through its source probe as serving 0076d673, a
 * descendant of 6bcfb9cb touching one test file; production external with no probe, which nothing
 * can read. ISS-90's runtime verdicts at 6bcfb9cb weighed `uncorroborated` against production for
 * as long as it waited at `awaiting_release`. Both environments deploy from `main` here, so the
 * release path holds no promotion and the hold weighs at what is served (`criteria-basis.ts`).
 * Driven against real Postgres, with the probes' answers and the source host's compares stubbed.
 *
 * @direct-test-of packages/core/src/issues/runtime-standing.ts
 * @direct-test-of packages/core/src/issues/verdict-standing.ts
 * @direct-test-of packages/core/src/release-batch/criteria-hold.ts
 * @direct-test-of packages/core/src/release-batch/runtime-weighing.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { SourceHost } from '../../src/integrations/source-host/index.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { unearnedCriteriaReports } from '../../src/issues/index.js';
import type { ReleaseBlocker, ReleaseWarning } from '../../src/release-batch/blocker-sentences.js';
import { criteriaHold } from '../../src/release-batch/criteria-hold.js';
import { readWeighingNow } from '../../src/release-batch/runtime-weighing.js';
import { readServingNow } from '../../src/release-batch/serving-reading.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const STG_PROBE = 'https://stg.example.test/api/v1/build-info';
const PRODUCTION_PROBE = 'https://app.example.test/api/v1/build-info';
const SERVED = '0076d673515fdb24a01de5af5d8ab1e448c156aa';
const ANCESTOR = '6bcfb9cb54a6ac89724a10f9f304671869c7bed7';
const UNRELATED = '9a258402c0ffee00c0ffee00c0ffee00c0ffee00';

let projectId: string;
let ownerId: string;
let stg: { status: number; body: unknown };

const probeOn = (url: string) => ({
  runtime: [{ type: 'http' as const, url, path: 'commit', identifies: 'source' as const }],
});

const environments = (stgProbe: boolean) => ({
  stg: {
    tier: 'staging' as const,
    deploysFrom: 'main',
    deployment: { mode: 'external' as const },
    url: 'https://stg.example.test',
    ...(stgProbe ? { verification: probeOn(STG_PROBE) } : {}),
  },
  production: {
    tier: 'production' as const,
    deploysFrom: 'main',
    deployment: { mode: 'external' as const },
    url: 'https://app.example.test',
  },
});

async function declare(opts: {
  judgedOn: string | null;
  stgProbe?: boolean;
  productionProbe?: boolean;
  onLand?: boolean;
}): Promise<void> {
  const declared = environments(opts.stgProbe ?? true);
  const production = opts.onLand
    ? {
        tier: 'production' as const,
        deploysFrom: 'main',
        deployment: { binding: randomUUID(), trigger: 'on-land' as const },
      }
    : opts.productionProbe
      ? { ...declared.production, verification: probeOn(PRODUCTION_PROBE) }
      : declared.production;
  await seedProjectDocument(projectId, ownerId, {
    environments: { ...declared, production },
    extra: {
      delivery: {
        verdictsRequired: true,
        ...(opts.judgedOn === null ? {} : { judgedOn: opts.judgedOn }),
      },
    },
  });
}

/** The source host as it answers: 0076d673 is ahead of 6bcfb9cb, and unrelated to 9a258402. */
const host = {
  fullName: 'acme/judged-on-weighing',
  compare: async (base: string) => (base === ANCESTOR ? 'ahead' : 'diverged'),
  compareFiles: async () => ({
    status: 'diverged',
    files: ['app/Http/Kernel.php'],
    changes: [],
  }),
  commitFiles: async () => ({ files: ['app/Http/Kernel.php'], changes: [] }),
} as unknown as SourceHost;

let seq = 0;

/** An issue at `awaiting_release` landed at 6bcfb9cb, its one criterion judged at `ref` at runtime. */
async function waitingIssue(ref: string): Promise<string> {
  seq += 1;
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
    VALUES (${projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${ownerId}, now(), ${ANCESTOR})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = (row as { id: string }).id;
  await replaceCriteria(id, [{ n: 1, statement: 'The build answers its commit.' }]);
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, runtime_ref,
                                    author_user_id, author_agency, judge)
    SELECT id, ${id}, 'pass', 'Called the route on stg.', 'runtime', ${ref}, ${ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${id} AND n = 1 AND retired_at IS NULL
  `);
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

/** The criteria report the release hold reads, through the readings it takes. */
async function weighed(issueId: string) {
  const serving = await readServingNow(projectId);
  const weighing = await readWeighingNow(projectId, serving, [issueId], {
    host: async () => host,
  });
  const [report] = await unearnedCriteriaReports([issueId], serving, weighing);
  if (!report) throw new Error(`no criteria report for ${issueId}`);
  return report;
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  stg = { status: 200, body: { commit: SERVED } };
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PRODUCTION_PROBE)) return Response.json({ commit: SERVED });
    if (!url.startsWith(STG_PROBE)) return real(input, init);
    return new Response(JSON.stringify(stg.body), { status: stg.status });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('an unreleased issue is weighed on the environment it was judged on', () => {
  it('carries a runtime verdict at an ancestor of what stg serves, while production cannot be read', async () => {
    await declare({ judgedOn: 'stg' });
    const report = await weighed(await waitingIssue(ANCESTOR));
    // carried: earned outright, not on a reading nothing could check
    expect(report.uncorroborated).toEqual([]);
    expect(report.unearned).toEqual([]);
    expect(report.weighedOn).toBe('stg');
    expect(report.serving).toMatchObject({ kind: 'serving', served: [{ commit: SERVED }] });
  });

  it('supersedes a runtime verdict at a commit stg does not carry, naming stg', async () => {
    await declare({ judgedOn: 'stg' });
    const report = await weighed(await waitingIssue(UNRELATED));
    expect(report.unearned).toHaveLength(1);
    const [held] = report.unearned;
    expect(held?.standing).toBe('superseded');
    expect(held?.why).toContain(`judged at ${UNRELATED}, which is not a commit \`stg\``);
    expect(held?.why).toContain('does not descend from it');
  });

  it('reads production once the issue is released', async () => {
    await declare({ judgedOn: 'stg' });
    const id = await waitingIssue(ANCESTOR);
    await seedIssueStatus(id, 'closed');
    const report = await weighed(id);
    expect(report.weighedOn).toBeNull();
    expect(report.serving).toMatchObject({ kind: 'undeclared' });
    expect(JSON.stringify(report.serving)).toContain('`production` is deployed outside Forge');
    expect(report.uncorroborated).toEqual([1]);
  });

  it('leaves uncorroborated where stg cannot be read, and never guesses', async () => {
    await declare({ judgedOn: 'stg' });
    stg = { status: 503, body: { error: 'down' } };
    const report = await weighed(await waitingIssue(ANCESTOR));
    expect(report.weighedOn).toBe('stg');
    expect(report.serving).toMatchObject({ kind: 'unreadable' });
    expect(report.unearned).toEqual([]);
    expect(report.uncorroborated).toEqual([1]);
  });

  it('keeps production where the project names no judged-on environment, and says so', async () => {
    await declare({ judgedOn: null, productionProbe: true });
    // production serves 0076d673 too, so a verdict at its ancestor is carried there
    expect((await weighed(await waitingIssue(ANCESTOR))).unearned).toEqual([]);
    const report = await weighed(await waitingIssue(UNRELATED));
    expect(report.weighedOn).toBeNull();
    expect(report.unearned[0]?.standing).toBe('superseded');
    expect(report.unearned[0]?.why).toContain(
      'the environment it was judged on is not known — this project names no environment its changes are judged on (`delivery.judgedOn`) — so it is weighed against production',
    );
  });

  it("warns, on an automatic release, with the reason stg could not be read, not production's", async () => {
    await declare({ judgedOn: 'stg', onLand: true });
    stg = { status: 503, body: { error: 'down' } };
    const id = await waitingIssue(ANCESTOR);
    const serving = await readServingNow(projectId);
    const weighing = await readWeighingNow(projectId, serving, [id], { host: async () => host });
    const out: ReleaseBlocker[] = [];
    const warnings: ReleaseWarning[] = [];
    await criteriaHold(projectId, [id], out, warnings, serving, weighing);
    expect(out).toEqual([]);
    const warned = warnings.find((w) => w.code === 'RELEASE_CRITERIA_UNCORROBORATED');
    expect(warned?.message).toContain('answered HTTP 503');
  });
});
