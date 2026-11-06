/**
 * ISS-1035 (FB-533) — the steward's facts about an issue's criteria are the weighing
 * `GET /api/issues/:id/criteria` serves (`release-batch/criteria-weighing.ts:criteriaWeighingOf`),
 * read when the facts are written. Planted from adminhub-api on 2026-11-06: work lands on
 * `release/stg`, a promotion carries it to `release/production`, and `stg` is the environment it is
 * judged on (`delivery.judgedOn`). ISS-189 held three runtime passes at its landing de10d638, which
 * the criteria read counted earned at the landing, while the steward, told only that "a release
 * criterion counts only a pass judged on the build `stg` serves", wrote three minutes later that all
 * three were missing on stg at de10d638 and asked the master for a judge. ISS-64 (commit identity at
 * its landing) and ISS-112 (runtime passes recorded after its landing) were read the same way.
 *
 * @direct-test-of packages/core/src/release-batch/steward-release-facts.ts
 * @direct-test-of packages/core/src/release-batch/landed-facts.ts
 * @direct-test-of packages/core/src/release-batch/criteria-weighing.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { stewardReleaseFacts } from '../../src/release-batch/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** The source host, answering every landing as an ancestor of what stg serves. */
const H = vi.hoisted(() => {
  const files = { files: ['app/Http/Kernel.php'], changes: [] };
  return {
    host: {
      fullName: 'sidcorp-it/canawan-api',
      compare: async () => 'ahead',
      compareFiles: async () => ({ status: 'diverged', ...files }),
      commitFiles: async () => files,
    },
  };
});

vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => H.host,
}));

const STG_PROBE = 'https://stg-adminhub-api.example.test/api/v1/build-info';
/** ISS-189's landing; stg serves a later build, as it did at 06:10 on 2026-11-06. */
const ISS189 = 'de10d6386389e6d3c0d5a5a1f0b0e8a7c6b5a4f3';
const ISS64 = 'd8c87920a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ISS112 = '5c0277cfd706a1b2c3d4e5f60718293a4b5c6d7e';
const SERVED = '0076d673515fdb24a01de5af5d8ab1e448c156aa';
const UNRELATED = '9a258402c0ffee00c0ffee00c0ffee00c0ffee00';

/** The sentence the facts carried, which the criteria read contradicts on a promotion project. */
const STG_RULE = 'a release criterion counts only a pass judged on the build `stg` serves';

let projectId: string;
let ownerId: string;
let token: string;
let seq = 0;

/** adminhub-api's document: lands on `release/stg`, promoted to `release/production`, judged on stg. */
async function adminhubApi(): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch: 'release/stg',
    promotions: [{ from: 'release/stg', to: 'release/production', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        url: 'https://stg-adminhub-api.example.test',
        verification: {
          runtime: [{ type: 'http', url: STG_PROBE, path: 'commit', identifies: 'source' }],
        },
      },
      production: {
        tier: 'production',
        deploysFrom: 'release/production',
        deployment: { mode: 'external' },
        url: 'https://adminhub-api.example.test',
      },
    } as never,
    extra: {
      release: { approval: { required: true }, changeRequests: false },
      delivery: { verdictsRequired: true, judgedOn: 'stg' },
    } as never,
  });
}

/**
 * An issue merged as `landing` on `release/stg` `mergedAgo` before now, waiting at
 * `awaiting_release`, with one criterion per verdict: a `pass` at `[kind, ref]` by the QA judge,
 * recorded now.
 */
async function landedIssue(
  landing: string,
  verdicts: ReadonlyArray<readonly ['commit' | 'runtime', string]>,
  mergedAgo = '1 minute',
): Promise<string> {
  seq += 1;
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, merged_target)
    VALUES (${projectId}, ${seq}, ${`ISS-${seq}`}, 'in_progress', ${ownerId},
            now() - ${mergedAgo}::interval, ${landing}, 'release/stg')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = (row as { id: string }).id;
  await replaceCriteria(
    id,
    verdicts.map((_, i) => ({ n: i + 1, statement: `Criterion ${i + 1} holds on stg.` })),
  );
  for (const [i, [kind, ref]] of verdicts.entries()) {
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind,
                                      commit_sha, runtime_ref, author_user_id, author_agency, judge)
      SELECT id, ${id}, 'pass', 'Called the route on stg.', ${kind},
             ${kind === 'commit' ? ref : null}, ${kind === 'runtime' ? ref : null},
             ${ownerId}, 'agent', 'qa'
        FROM issue_criteria WHERE issue_id = ${id} AND n = ${i + 1} AND retired_at IS NULL
    `);
  }
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

interface Weighing {
  earned: boolean | null;
  reason: string;
}

/** Each live criterion's weighing, by number, as `GET /api/issues/:id/criteria` answers it. */
async function weighed(issueId: string): Promise<Map<number, Weighing>> {
  const res = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const criteria = res.body.criteria as Array<{ n: number; weighing: Weighing }>;
  return new Map(criteria.map((c) => [c.n, c.weighing]));
}

/** The facts agree with the read: each criterion named with the read's own word and reason. */
async function factsAgree(issueId: string): Promise<string> {
  const read = await weighed(issueId);
  const said = await stewardReleaseFacts(projectId, issueId);
  for (const [n, w] of read) {
    const word = w.earned === true ? 'earned' : w.earned === false ? 'owed' : 'undecided';
    expect(said).toContain(`criterion ${n} ${word}: ${w.reason}`);
  }
  expect(said).not.toContain(STG_RULE);
  return said;
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
    if (url.startsWith(STG_PROBE)) return Response.json({ commit: SERVED });
    return real(input, init);
  });
  await adminhubApi();
});

afterEach(() => vi.restoreAllMocks());

describe("the steward's facts are the criteria read's weighing (adminhub-api, 2026-11-06)", () => {
  it('ISS-189: three runtime passes at the landing on release/stg are earned in the facts, and nothing is owed', async () => {
    const id = await landedIssue(ISS189, [
      ['runtime', ISS189],
      ['runtime', ISS189],
      ['runtime', ISS189],
    ]);

    const read = await weighed(id);
    for (const n of [1, 2, 3]) expect(read.get(n)?.earned).toBe(true);

    const said = await factsAgree(id);
    expect(said).not.toContain('owed:');
    expect(said).not.toContain('dispatch a judge');
  });

  it('ISS-64: six commit passes at the landing are earned in the facts', async () => {
    const id = await landedIssue(
      ISS64,
      Array.from({ length: 6 }, () => ['commit', ISS64] as const),
    );

    const read = await weighed(id);
    for (let n = 1; n <= 6; n += 1) expect(read.get(n)?.earned).toBe(true);

    const said = await factsAgree(id);
    expect(said).not.toContain('dispatch a judge');
  });

  it('ISS-112: runtime passes recorded long after the landing, at its commit, are earned in the facts', async () => {
    const id = await landedIssue(
      ISS112,
      [
        ['runtime', ISS112],
        ['runtime', ISS112],
        ['runtime', ISS112],
      ],
      '3 hours',
    );

    const read = await weighed(id);
    for (const n of [1, 2, 3]) expect(read.get(n)?.earned).toBe(true);

    const said = await factsAgree(id);
    expect(said).not.toContain('dispatch a judge');
  });

  it('names the one criterion the weighing owes, with its reason, and only that one', async () => {
    const id = await landedIssue(ISS189, [
      ['runtime', ISS189],
      ['commit', ISS189],
      ['runtime', UNRELATED],
    ]);

    const read = await weighed(id);
    expect(read.get(3)?.earned).toBe(false);

    const said = await factsAgree(id);
    expect(said).toContain('criterion 3 owed:');
    expect(said).not.toContain('criterion 1 owed');
    expect(said).not.toContain('criterion 2 owed');
    expect(said).toContain(`dispatch a judge at \`${ISS189.slice(0, 12)}\``);
  });
});
