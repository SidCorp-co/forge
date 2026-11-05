/**
 * ISS-1001 criterion 6, FB-515 (adminhub-api 0.10.0, 2026-11-05): production serves 40ec84e8, and the
 * release read ISS-163, 167, 169 and 25 as `proof: "open"` while each issue's own criteria read
 * `earned: true` at its landing c54e6b82, an ancestor. The release counted only a verdict judged at its
 * exact build; the issue weighs at the landing (`criteria-basis.ts:landingCriteriaReports`). The
 * release now reads each issue's proof through that same weighing, so the two never disagree.
 * Against real Postgres.
 *
 * Round 2 (dev.515): the header read 110/111 while the page's Technical "Still open" listed ISS-25
 * "9 open" and its `knownIssues` carried 62 `not_judged`, the page weighing every criterion a second
 * time at the exact build. The page now lists what the release record weighed, once.
 *
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/release-page/read.ts
 * @direct-test-of packages/core/src/release-page/claims.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';
import {
  call,
  EXTERNAL,
  HEAD,
  LANDED,
  landedIssues,
  promotionRequest,
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

const LANDING = LANDED[0] as string;

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seedPromotionWorld(EXTERNAL, { verdictsRequired: true });
});

/** ISS-163: landed at `LANDING` on release/stg, both its criteria passed there by QA. */
async function earnedAtItsLanding(): Promise<string> {
  const [id] = await landedIssues([LANDING]);
  const issue = id as string;
  await seedIssueStatus(issue, 'in_progress');
  await replaceCriteria(issue, [
    { n: 1, statement: 'A site syncs its catalog' },
    { n: 2, statement: 'A sync says when it ran' },
  ]);
  await seedIssueStatus(issue, 'awaiting_release');
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT id, ${issue}, 'pass', 'held on stg at the landing', 'commit', ${LANDING},
           ${world.ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${issue} AND retired_at IS NULL`);
  return issue;
}

describe('a release reads each issue proven where the issue weighs it earned (FB-515)', () => {
  it('counts a pass at the landing, an ancestor of the promotion head, on the release', async () => {
    const issue = await earnedAtItsLanding();
    const weighed = await api(world.token, 'GET', `/api/issues/${issue}/criteria`);
    expect(weighed.status, JSON.stringify(weighed.body)).toBe(200);
    const earned = (weighed.body.criteria as Array<{ weighing?: { earned: boolean | null } }>).map(
      (c) => c.weighing?.earned,
    );
    expect(earned, 'the issue weighs both earned at its landing').toEqual([true, true]);

    await promotionRequest(5053, HEAD);
    const cut = await call('POST', '/release-batches', {
      issueIds: [issue],
      promotion: { request: 5053 },
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const read = await call('GET', `/releases/${String(cut.body.version)}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const release = read.body.release as {
      verified: { proven: number; total: number };
      contents: Array<{ issues: Array<{ key: string; proof: string }> }>;
    };
    expect(release.verified).toMatchObject({ proven: 2, total: 2 });
    expect(release.contents.flatMap((g) => g.issues.map((i) => [i.key, i.proof]))).toEqual([
      ['ISS-1', 'proven'],
    ]);
  });

  // adminhub-api 0.10.0 on dev.515: 110/111 at the top, ISS-25 "9 open" under Technical
  it('lists nothing open on the page that the header counts proven, in either view', async () => {
    const issue = await earnedAtItsLanding();
    await promotionRequest(5053, HEAD);
    const cut = await call('POST', '/release-batches', {
      issueIds: [issue],
      promotion: { request: 5053 },
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    for (const view of ['user', 'developer']) {
      const read = await call('GET', `/releases/${String(cut.body.version)}/page?view=${view}`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      const page = read.body as {
        header: { verified: { proven: number; total: number } };
        knownIssues: Array<{ issueKey: string; standing: string }>;
        requirements: Array<{ proven: unknown[]; unproven: number }>;
        untraced: { proven: unknown[]; unproven: number } | null;
      };
      expect(page.header.verified, view).toMatchObject({ proven: 2, total: 2 });
      expect(
        page.knownIssues.map((k) => [k.issueKey, k.standing]),
        `${view}: an issue its own record reads earned is never open on the page`,
      ).toEqual([]);
      const groups = [...page.requirements, ...(page.untraced ? [page.untraced] : [])];
      expect(
        groups.map((g) => [g.proven.length, g.unproven]),
        `${view}: the page's lists sum to the header's count`,
      ).toEqual([[2, 0]]);
    }
  });
});
