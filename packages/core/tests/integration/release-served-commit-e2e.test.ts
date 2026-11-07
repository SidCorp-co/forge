/**
 * ISS-1079 round 2 (FB-545, sidcorp-mail 0.16.0): the live repair was refused
 * `RELEASE_SHIPPED_COMMIT_HELD`. Release run 8250311b's finish had named 6118831f, "release 0.16.0:
 * admin-ui/VERSION", and production served 62a4ac7, the merge of release/0.16.0 into master, which
 * descends from it and from every landing; the passes judged there still counted for nothing (REQ-6
 * read 0/0). The commit a deploy is seen serving is the one shipped, the finish's kept as `named`, and
 * the door corrects a finish-named commit to a served descendant holding every landing. Against real
 * Postgres, on the promotion project round 1's witness plants.
 *
 * @direct-test-of packages/core/src/release-batch/shipped-commit.ts
 * @direct-test-of packages/core/src/release-batch/shipped-holding.ts
 * @direct-test-of packages/core/src/release-batch/finish-record.ts
 * @direct-test-of packages/core/src/release-batch/finish-job.ts
 * @direct-test-of packages/core/src/release-batch/coolify-confirm.ts
 * @direct-test-of packages/core/src/release-batch/release-tag.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { applyDeploySettlement } from '../../src/release-batch/coolify-confirm.js';
import { acceptReleaseBatchFinish } from '../../src/release-batch/finish-job.js';
import { recordObservedShippedCommit } from '../../src/release-batch/shipped-commit.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import { landedIssue, world } from '../helpers/landed-world.js';
import { ELSEWHERE, LANDING, NAMED, SHIPPED } from '../helpers/shipped-commit-host.js';
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
  NAMED_BY_FINISH,
  passedAt,
  shippedCommitOf,
  shippedRun,
  storedOf,
  tagOwedOn,
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

describe('a release whose deploy serves a descendant of the commit its finish named ships that one (ISS-1079 r2)', () => {
  it('records the served commit once the deploy settles after the finish, keeping the named one', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('pending'), {
      commit: NAMED,
      source: NAMED_BY_FINISH,
      extra: tagOwedOn(NAMED, false),
    });
    expect(await coverageOf(req), 'FB-545 r2: a pass at the served commit counts nothing').toEqual({
      criteria: 1,
      passing: 0,
      judged: 0,
    });

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

    const { finish, tagOwed } = await storedOf(runId);
    expect(finish).toMatchObject({ commit: SHIPPED, shipped: { from: 'deploy', named: NAMED } });
    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(tagOwed, 'the tag not yet put follows the shipped commit').toBe(SHIPPED);
    expect(await earnedOf(issue)).toBe(true);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('records it when the finish job completes a finish naming another commit after the deploy', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await landedIssue(11, LANDING, ['The webmail serves the release build']);
    await traced(req, issue, 11, { 1: 'BC-1' });
    await passedAt(issue, SHIPPED);
    const runId = await claimedByRun(issue, hold('succeeded', SHIPPED));

    await acceptReleaseBatchFinish(
      runId,
      { type: 'user', id: world.ownerId, agency: 'agent' },
      { commit: NAMED },
    );
    const finish = await finishedRecord(runId);

    expect(finish, JSON.stringify(finish)).toMatchObject({ state: 'finished', closed: [issue] });
    const until = Date.now() + 10_000;
    while ((await shippedCommitOf(runId)) !== SHIPPED && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect((await storedOf(runId)).finish).toMatchObject({
      commit: SHIPPED,
      shipped: { from: 'deploy', named: NAMED },
    });
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('keeps a tag the host already put on the named commit, since a tag is never moved', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('succeeded', SHIPPED), {
      commit: NAMED,
      source: NAMED_BY_FINISH,
      extra: tagOwedOn(NAMED, true),
    });
    const recorded = await recordObservedShippedCommit(runId);

    expect(recorded).toMatchObject({ commit: SHIPPED, from: 'deploy', named: NAMED });
    expect((await storedOf(runId)).tagOwed).toBe(NAMED);
  });

  it('says so, and ships nothing new, where the deploy serves a commit not descending from the named one', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('succeeded', ELSEWHERE), {
      commit: NAMED,
      source: NAMED_BY_FINISH,
    });
    const recorded = await recordObservedShippedCommit(runId);

    expect(recorded).toMatchObject({ commit: NAMED, from: 'finish' });
    const { finish } = await storedOf(runId);
    expect(finish).toMatchObject({ commit: NAMED, shipped: { from: 'finish' } });
    const served = (finish.shipped as { served?: { commit: string; why: string } }).served;
    expect(served?.commit).toBe(ELSEWHERE);
    expect(served?.why).toContain('does not descend from');
    expect(served?.why).toContain(NAMED.slice(0, 12));
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 0, judged: 0 });
  });
});

describe('the door corrects a commit the finish named to the descendant production serves (ISS-1079 r2)', () => {
  it('takes the served descendant over sidcorp-mail 0.16.0 as it stands, and the verdicts there count', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    // as the live run stands: finished before ISS-1079, so its record says nothing of where it came from
    const runId = await shippedRun(issue, {}, { commit: NAMED });
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 0, judged: 0 });

    const res = await attach(runId, SHIPPED);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ runId, commit: SHIPPED, from: 'attached', named: NAMED });
    const { finish } = await storedOf(runId);
    expect(finish).toMatchObject({ commit: SHIPPED, shipped: { from: 'attached', named: NAMED } });
    expect((finish.shipped as { said: string }).said).toContain(`answered ${SHIPPED}`);
    expect(await earnedOf(issue)).toBe(true);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('refuses a commit that does not descend from the held one, naming both', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, {}, { commit: NAMED, source: NAMED_BY_FINISH });

    const res = await attach(runId, ELSEWHERE);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('RELEASE_SHIPPED_COMMIT_HELD');
    expect(JSON.stringify(res.body)).toContain(NAMED.slice(0, 12));
    expect(JSON.stringify(res.body)).toContain(ELSEWHERE.slice(0, 12));
    expect(await shippedCommitOf(runId)).toBe(NAMED);
  });

  it('refuses to replace a commit a deploy was seen serving', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(
      issue,
      {},
      {
        commit: NAMED,
        source: { from: 'deploy', said: 'the deploy of `production` reported building it' },
      },
    );

    const res = await attach(runId, SHIPPED);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('RELEASE_SHIPPED_COMMIT_SETTLED');
    expect(JSON.stringify(res.body)).toContain('deploy');
    expect(await shippedCommitOf(runId)).toBe(NAMED);
  });

  it('refuses the commit it already holds', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, {}, { commit: NAMED, source: NAMED_BY_FINISH });

    const res = await attach(runId, NAMED);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('RELEASE_SHIPPED_COMMIT_SAME');
    expect(JSON.stringify(res.body)).toContain(NAMED.slice(0, 12));
  });
});
