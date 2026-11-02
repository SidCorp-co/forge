/**
 * ISS-849 — a requirement on a promotion project counts a criterion its shipped issue earned at its
 * landing, by the weighing the issue's own criteria read shows. Planted from adminhub-api on
 * 2026-11-01: work lands on `release/stg` and a promotion carries it to `release/production`; REQ-11
 * is delivered by ISS-53, shipped at landing b8c8b8923, whose six criteria trace BC-1..5 and read
 * `weighing.earned: true` there (review passes on 1-3, QA passes on 4-6, all at the landing). What is
 * served is another commit, 67264868e, which no release or recorded ancestry places. Coverage read
 * those passes against the live build instead of the landing, so REQ-11 answered
 * `{ criteria: 5, passing: 0, judged: 0 }` and its standing kept asking the judge for BC-1..5.
 *
 * @direct-test-of packages/core/src/release-batch/criteria-basis.ts
 * @direct-test-of packages/core/src/release-batch/landed-build-holds.ts
 * @direct-test-of packages/core/src/requirements/standing-facts.ts
 * @direct-test-of packages/core/src/requirements/standing-coverage.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, requirementRead, traced } from '../helpers/landed-requirement.js';
import { landedIssue, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** ISS-53's landing on `release/stg`, and what stg and production serve: an unrelated commit. */
const LANDING = 'b8c8b8923a1d4e5f60718293a4b5c6d7e8f90a1b';
const SERVED = '67264868e0f1a2b3c4d5e6f708192a3b4c5d6e7f';
const STG_PROBE = 'https://stg-adminhub-api.example.test/api/v1/build-info';
const PRODUCTION_PROBE = 'https://adminhub-api.example.test/api/v1/build-info';

const BCS = [
  'An admin lists the accounts',
  'An account opens from its row',
  'A search narrows the accounts',
  'An empty list says so',
  'A disabled account is marked',
];

/** ISS-53's criterion n traces BC-(trace[n]): six criteria over five business criteria. */
const TRACES = { 1: 'BC-1', 2: 'BC-2', 3: 'BC-3', 4: 'BC-4', 5: 'BC-5', 6: 'BC-5' } as const;

const probeOn = (url: string) => ({
  runtime: [{ type: 'http' as const, url, path: 'commit', identifies: 'source' as const }],
});

/** adminhub-api's document: lands on `release/stg`, promoted by merge to `release/production`. */
async function promotionProject(): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'release/stg',
    promotions: [{ from: 'release/stg', to: 'release/production', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        url: 'https://stg-adminhub-api.example.test',
        verification: probeOn(STG_PROBE),
      },
      production: {
        tier: 'production',
        deploysFrom: 'release/production',
        deployment: { mode: 'external' },
        url: 'https://adminhub-api.example.test',
        verification: probeOn(PRODUCTION_PROBE),
      },
    } as never,
    extra: {
      release: { approval: { required: true }, changeRequests: false },
      delivery: { verdictsRequired: true, judgedOn: 'stg' },
    } as never,
  });
}

/** A pass on criterion `n` at `commit`, by the review or by QA, as each records it. */
async function passed(issueId: string, n: number, judge: 'review' | 'qa', commit: string) {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT id, ${issueId}, 'pass', ${`(REQ-11 BC-${n}) held at ${commit}`}, 'commit', ${commit},
           ${world.ownerId}, 'agent', ${judge}
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `);
}

/** Each live criterion's weighing, by number, as `GET /api/issues/:id/criteria` answers it. */
async function weighingOf(issueId: string) {
  const res = await api(world.token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const criteria = res.body.criteria as Array<{
    n: number;
    weighing?: { earned: boolean | null; weighedOn: Record<string, unknown> };
  }>;
  return new Map(criteria.map((c) => [c.n, c.weighing]));
}

/** ISS-53: landed at `LANDING`, its six criteria traced and passed there, shipped. */
async function shippedIssue(req: string): Promise<string> {
  const issue = await landedIssue(
    53,
    LANDING,
    Object.keys(TRACES).map((n) => `Criterion ${n} holds on stg`),
  );
  await traced(req, issue, 53, TRACES);
  for (const n of [1, 2, 3]) await passed(issue, n, 'review', LANDING);
  for (const n of [4, 5, 6]) await passed(issue, n, 'qa', LANDING);
  await seedIssueStatus(issue, 'closed');
  return issue;
}

beforeEach(async () => {
  await seedLandedWorld();
  await promotionProject();
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

describe('a promotion project: coverage counts what its shipped issue earned at its landing (ISS-849)', () => {
  it('reads every BC passing where the issue weighs every traced criterion earned at its landing', async () => {
    const req = await agreedRequirement(BCS);
    const issue = await shippedIssue(req);

    // the issue's own weighing: every criterion earned at the landing, not at what is served
    const weighed = await weighingOf(issue);
    for (const n of Object.keys(TRACES).map(Number)) {
      expect(weighed.get(n), `criterion ${n}`).toMatchObject({
        earned: true,
        weighedOn: { basis: 'landing', landing: LANDING, landsOn: 'release/stg' },
      });
    }

    const read = await requirementRead(req);
    expect(read.standing.delivery.criteriaCoverage).toEqual({ criteria: 5, passing: 5, judged: 5 });
    expect(read.standing.coverage.map((c) => [c.code, c.verdict])).toEqual(
      BCS.map((_, i) => [`BC-${i + 1}`, 'passing']),
    );
    for (const bc of read.standing.coverage) {
      for (const link of bc.issues) expect(link.notCounted, bc.code).toBeNull();
    }
    // no turn asks the judge to judge what the issue already earned
    expect(JSON.stringify(read.standing)).not.toContain('standing.act.judgeOn');
  });

  it('still names a pass judged at what is served, not at the landing, as not counted there', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(53, LANDING, ['Criterion 1 holds on stg']);
    await traced(req, issue, 53, { 1: 'BC-1' });
    await passed(issue, 1, 'qa', SERVED);
    await seedIssueStatus(issue, 'closed');

    expect((await weighingOf(issue)).get(1)).toMatchObject({ earned: false });
    const read = await requirementRead(req);
    expect(read.standing.delivery.criteriaCoverage).toEqual({ criteria: 1, passing: 0, judged: 0 });
    const [bc] = read.standing.coverage;
    expect(bc?.verdict).toBe('not_live');
    expect(bc?.issues[0]?.notCounted).toContain(`not at its issue's landing ${LANDING.slice(0, 12)}`);
    // the one BC the issue did not earn is the one its turn asks to be judged again
    expect(JSON.stringify(read.standing)).toContain('standing.act.judgeOn');
  });
});
