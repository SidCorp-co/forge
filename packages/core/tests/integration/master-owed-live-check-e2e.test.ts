/**
 * ISS-1200 (epod, 2026-11-10): epod's master shipped v1.48.0 and went outdated. Nothing core read as
 * its work counted the live verdicts the release owed, so the verdict kept the pane draining
 * (`heldNoWork`): drained, the box refused its `run declare`, and no successor was placed, so the
 * release's live checks had no pane that could run them.
 *
 * Planted: an outdated, idle master pane on a project whose production is deployed outside Forge,
 * its latest shipped release carrying an issue whose criterion nobody judged on it. The live verdict
 * it owes is master work, so the pane is replaced, resuming its conversation, and its nudge names
 * the check. Once the verdict is recorded on the release, nothing is owed and the pane drains again:
 * the count reaches zero. An older release's unjudged criterion is not owed once a newer one shipped.
 *
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/masters/verdict.ts
 */

import { describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { api } from '../helpers/api.js';
import { bindTestRunner, createTestDevice } from '../helpers/factories.js';
import { F4, landedIssue, ok, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Doc = Record<string, unknown>;

const ACCOUNT = 'epod-deploy shipped this tag to production; /healthz reports it.';

/** epod's shape: production deployed outside Forge, criteria judged after the release ships. */
async function externalProduction(): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'release/stg',
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external', target: 'epod-deploy' },
      },
    } as never,
    extra: { delivery: { verdictsRequired: false } } as never,
  });
}

/** An alive master pane placed with a plugin the box would no longer hand it, idle and holding nothing. */
function outdatedFacts(over: Doc = {}): Doc {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: 'alive',
    capability: 'current',
    serversReadable: true,
    work: { poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-1200', transcript: 'present', elsewhere: 'none' },
    placement: {
      placed: { plugins: 'f6ef27930525' },
      unreadable: null,
      now: { plugins: '874fabc528bc' },
    },
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: null,
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: { last: null, since: 'unreported' },
    ...over,
  };
}

async function box(): Promise<{ token: string; runnerId: string }> {
  const deviceId = await createTestDevice(world.ownerId);
  const runnerId = await bindTestRunner(world.projectId, deviceId);
  const token = (
    await mintPat({
      permissions: ['*'],
      userId: world.ownerId,
      name: 'box',
      deviceId,
      projectIds: [world.projectId],
    })
  ).plaintext;
  await ok(
    api(token, 'POST', '/api/devices/me/master-session', {
      projectId: world.projectId,
      name: 'forge-master-live-check',
      maxJobPanes: 1,
    }),
  );
  return { token, runnerId };
}

const verdictOf = async (b: { token: string; runnerId: string }, over: Doc = {}) =>
  (await ok(
    api(b.token, 'POST', '/api/devices/me/master-session/verdict', {
      projectId: world.projectId,
      runnerId: b.runnerId,
      facts: outdatedFacts(over),
    }),
  )) as { verdict: Doc & { because: string }; work: Doc & { nudge: string } };

const recordRelease = (issueIds: string[], version: string) =>
  ok(
    api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
      issueIds,
      version,
      account: ACCOUNT,
    }),
  );

const judgedOn = (issueId: string, version: string) =>
  ok(
    api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: `Opened the order page on production ${version}.`,
      identity: { kind: 'release', version },
      evidence: ['https://epod.example.test/clips/orders.webm'],
    }),
  );

describe('ISS-1200: a live verdict owed on the latest shipped release is master work', () => {
  it('replaces an outdated idle pane owing a live check, and drains it again once the check is recorded', async () => {
    await seedLandedWorld();
    await externalProduction();
    const b = await box();
    const shipped = await landedIssue(1, F4, ['A customer opens the order page']);
    await recordRelease([shipped], '1.48.0');

    const owing = await verdictOf(b);
    expect(owing.work).toMatchObject({ admissible: 0, owed: 1 });
    expect(owing.verdict).toMatchObject({
      act: 'replace',
      reason: 'outdated',
      resume: 'conv-1200',
      nudge: true,
    });
    expect(owing.work.nudge).toContain('1.48.0');
    expect(owing.work.nudge).toContain(`ISS-1 ${shipped}`);

    // a pane still holding a working run drains and is not yet replaced: the wait is named
    const holding = await verdictOf(b, {
      holding: {
        kind: 'these',
        runs: [{ name: 'run-a', subagent: { kind: 'resumed', silentMs: 0 } }],
      },
    });
    expect(holding.verdict).toMatchObject({ act: 'keep', drain: true });
    expect(holding.verdict.because).toContain(
      '1 owed live verdict(s) wait on a pane to judge them',
    );

    // recorded: the count reaches zero, so nothing holds the pane from draining
    await judgedOn(shipped, '1.48.0');
    const done = await verdictOf(b);
    expect(done.work).toMatchObject({ admissible: 0, owed: 0 });
    expect(done.verdict).toMatchObject({ act: 'keep', drain: true });
    expect(done.verdict.because).toContain('no admissible work: a successor would have nothing');
    expect(done.verdict.because).not.toContain('live verdict');
  });

  it('owes nothing for an older release once a newer one shipped', async () => {
    await seedLandedWorld();
    await externalProduction();
    const b = await box();
    await recordRelease([await landedIssue(1, F4, ['A customer opens the order page'])], '1.47.0');
    const newer = await landedIssue(2, F4, ['A customer pays for an order']);
    await recordRelease([newer], '1.48.0');
    await judgedOn(newer, '1.48.0');

    const answer = await verdictOf(b);
    expect(answer.work).toMatchObject({ admissible: 0, owed: 0 });
    expect(answer.verdict).toMatchObject({ act: 'keep', drain: true });
  });
});
