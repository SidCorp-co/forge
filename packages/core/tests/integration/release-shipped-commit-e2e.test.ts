/**
 * ISS-1079, FB-545 (sidcorp-mail 0.16.0, 2026-11-06): release run 8250311b was cut over ISS-11, its
 * deploy was seen and its finish finished, and nothing recorded the commit production serves
 * (62a4ac7, release/0.16.0 merged into master). Seven passes judged live at that commit counted for
 * nothing: REQ-6 read 0/0. A release's verdicts reach the issues it carried only through the commit
 * it shipped (`shipped-releases.ts:shippedReleaseRuns`, `landed-build-holds.ts:laterHoldersOf`), and
 * no door could attach one afterwards. Planted on a promotion project, as sidcorp-mail is: work lands
 * on `release/stg` and production deploys `release/production`. Against real Postgres.

 *
 * @direct-test-of packages/core/src/release-batch/shipped-commit.ts
 * @direct-test-of packages/core/src/release-batch/shipped-holding.ts
 * @direct-test-of packages/core/src/release-batch/landed-build-holds.ts
 * @direct-test-of packages/core/src/release-batch/finish-job.ts
 * @direct-test-of packages/core/src/release-batch/finish-record.ts
 * @direct-test-of packages/core/src/pipeline/deploy-confirmations.ts
 * @direct-test-of packages/core/src/release-batch/coolify-confirm.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyDeploySettlement } from '../../src/release-batch/coolify-confirm.js';
import { acceptReleaseBatchFinish } from '../../src/release-batch/finish-job.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import { landedIssue, world } from '../helpers/landed-world.js';
import { ELSEWHERE, LANDING, SHIPPED } from '../helpers/shipped-commit-host.js';
import {
  attach,
  claimedByRun,
  codeOf,
  coverageOf,
  DELIVERY,
  earnedOf,
  finishedRecord,
  hold,
  judgedLive,
  passedAt,
  shippedCommitOf,
  shippedRun,
  useShippedCommitWorld,
} from '../helpers/shipped-commit-world.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const { hostCompare } = await import('../helpers/shipped-commit-host.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => ({
      provider: 'gitlab',
      fullName: 'sidcorp/mail',
      compare: hostCompare,
      readChangeRequestChecks: async () => [],
    }),
  };
});

useShippedCommitWorld();

describe('a release that completes on a seen deploy records its shipped commit (ISS-1079)', () => {
  it('reads FB-545 first: a finished release naming no commit counts nothing at that commit', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    await shippedRun(issue);

    expect(await earnedOf(issue)).toBe(false);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 0, judged: 0 });
  });

  it('records the commit the deploy reported once the deploy settles after the finish', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('pending'));

    await applyDeploySettlement(
      {
        bindingId: randomUUID(),
        runId,
        deliveryId: DELIVERY,
        deploymentUuid: 'deployment-1',
        targetLabel: 'production',
        commit: SHIPPED,
      } as Parameters<typeof applyDeploySettlement>[0],
      'succeeded',
    );

    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(await earnedOf(issue)).toBe(true);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('records the commit the deploy reported once the finish completes after the deploy', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('succeeded', SHIPPED));
    // the finish job's completion, after its attempt wrote `finished`
    const { recordObservedShippedCommit } = await import(
      '../../src/release-batch/shipped-commit.js'
    );

    const recorded = await recordObservedShippedCommit(runId);

    expect(recorded).toMatchObject({ commit: SHIPPED, from: 'deploy' });
    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('records it when the finish job completes a finish that named no commit', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await landedIssue(11, LANDING, ['The webmail serves the release build']);
    await traced(req, issue, 11, { 1: 'BC-1' });
    await passedAt(issue, SHIPPED);
    const runId = await claimedByRun(issue, hold('succeeded', SHIPPED));

    await acceptReleaseBatchFinish(runId, {
      type: 'user',
      id: world.ownerId,
      agency: 'agent',
    });
    const finish = await finishedRecord(runId);

    expect(finish, JSON.stringify(finish)).toMatchObject({ state: 'finished', closed: [issue] });
    const until = Date.now() + 10_000;
    while ((await shippedCommitOf(runId)) === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('says why where nothing the deploy reported names a whole commit', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('succeeded'));
    const { recordObservedShippedCommit } = await import(
      '../../src/release-batch/shipped-commit.js'
    );

    const recorded = await recordObservedShippedCommit(runId);

    expect(recorded).toMatchObject({ commit: null, from: null });
    expect(recorded?.said).toContain('shipped-commit');
    const [row] = [
      ...(await db.execute<{ said: string | null }>(sql`
        SELECT metadata -> 'finish' -> 'shipped' ->> 'said' AS said FROM pipeline_runs WHERE id = ${runId}`)),
    ];
    expect(row?.said, 'the finish record says why it names no commit').toContain('no deploy');
    expect(await shippedCommitOf(runId)).toBeNull();
  });
});

describe('a completed release without a shipped commit takes one through its door (ISS-1079)', () => {
  it('attaches the commit and the verdicts judged there count for the issues it carried', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue);

    const res = await attach(runId, SHIPPED);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ runId, commit: SHIPPED, from: 'attached' });
    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(await earnedOf(issue)).toBe(true);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('refuses a commit that does not carry the landing of an issue the release carried', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue);

    const res = await attach(runId, ELSEWHERE);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('RELEASE_SHIPPED_COMMIT_LACKS_LANDING');
    expect(JSON.stringify(res.body)).toContain('ISS-11');
    expect(JSON.stringify(res.body)).toContain(LANDING.slice(0, 12));
    expect(await shippedCommitOf(runId)).toBeNull();
  });

  it('refuses the commit it already holds, and any other once an agent attached one, naming it', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue);
    expect((await attach(runId, SHIPPED)).status).toBe(201);

    const again = await attach(runId, SHIPPED);
    const other = await attach(runId, ELSEWHERE);

    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(codeOf(again.body)).toBe('RELEASE_SHIPPED_COMMIT_SAME');
    expect(JSON.stringify(again.body)).toContain(SHIPPED.slice(0, 12));
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(codeOf(other.body)).toBe('RELEASE_SHIPPED_COMMIT_SETTLED');
    expect(JSON.stringify(other.body)).toContain(SHIPPED.slice(0, 12));
    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
  });

  it('refuses a release run that has not shipped', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, {}, { shipped: false });

    const res = await attach(runId, SHIPPED);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('RELEASE_SHIPPED_COMMIT_NOT_SHIPPED');
  });
});
