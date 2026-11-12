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
 * A check counts only where a judge can get in (FB-611, sid-desk): the environment the project
 * judges on names a testing profile, and no person owes an open question on the issue. Otherwise it
 * is no master work, so it neither keeps nor replaces a pane, and the nudge names it as a wait on a
 * person, with no judging run asked for.
 *
 * ISS-1223 (catalog-api 0.6.0): a project judged on a testing environment counts only runtime
 * verdicts at the release build, so criteria the owner accepted as proven by the suite at a named
 * commit were asked of the master every pass. A commit pass naming that decision stands accepted on
 * the release (REQ-36 BC-22): it owes no live verdict and is never proven. One naming a decision,
 * criterion or sha that cannot be placed is refused by name, and nothing is written.
 *
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/masters/verdict.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-acceptance.ts
 * @direct-test-of packages/core/src/release-batch/criterion-reading.ts
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { bindTestRunner, createTestDevice } from '../helpers/factories.js';
import {
  ASIDE,
  F4,
  LATER,
  landedIssue,
  laterLanding,
  ok,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Doc = Record<string, unknown>;

const ACCOUNT = 'epod-deploy shipped this tag to production; /healthz reports it.';

/**
 * epod's shape: production deployed outside Forge, criteria judged after the release ships, and a
 * testing profile on production a judge signs in with; sid-desk's (FB-611) where `testing` is false.
 */
async function externalProduction(testing = true, judgedOn?: string): Promise<void> {
  if (testing) {
    await db.execute(sql`
      INSERT INTO project_testing_profiles (project_id, profile_id, revision, document, updated_by)
      VALUES (${world.projectId}, 'prod-qa', 1, ${JSON.stringify({ actors: {}, services: {} })}::jsonb,
              ${world.ownerId})`);
  }
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'release/stg',
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external', target: 'epod-deploy' },
        ...(testing ? { testing: 'prod-qa' } : {}),
      },
    } as never,
    extra: { delivery: { verdictsRequired: false, ...(judgedOn ? { judgedOn } : {}) } } as never,
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

  it('owes no master work where the environment judged on has no testing profile, and says the wait', async () => {
    await seedLandedWorld();
    await externalProduction(false);
    const b = await box();
    const shipped = await landedIssue(1, F4, ['A signed-in agent sees the inbox']);
    await recordRelease([shipped], '0.21.0');

    const answer = await verdictOf(b);
    expect(answer.work).toMatchObject({ admissible: 0, owed: 0 });
    expect(answer.verdict).toMatchObject({ act: 'keep', drain: true });
    expect(answer.work.nudge).toContain(`ISS-1 ${shipped}`);
    expect(answer.work.nudge).toContain('`production` names no testing profile');
    expect(answer.work.nudge).not.toContain('--role qa');
  });

  it('owes no master work while a person owes an open question on the issue, and says the wait', async () => {
    await seedLandedWorld();
    await externalProduction();
    const b = await box();
    const shipped = await landedIssue(1, F4, ['A signed-in agent sees the inbox']);
    await recordRelease([shipped], '0.21.0');
    await db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
      VALUES (gen_random_uuid(), ${world.projectId}, ${shipped}, 'open', 'human', '[]'::jsonb)`);

    const answer = await verdictOf(b);
    expect(answer.work).toMatchObject({ admissible: 0, owed: 0 });
    expect(answer.verdict).toMatchObject({ act: 'keep', drain: true });
    expect(answer.work.nudge).toContain(`ISS-1 ${shipped}`);
    expect(answer.work.nudge).toContain('a person owes an open question on it');
    expect(answer.work.nudge).not.toContain('--role qa');
  });

  // ISS-1218: ISS-1216's criteria were skipped for want of a route, and the nudge kept asking for a
  // judging run: a question, its one way out, is refused on the closed issue it counts.
  it('owes no master work once every criterion still open is skipped at the release, and names what is missing', async () => {
    await seedLandedWorld();
    await externalProduction();
    const b = await box();
    const shipped = await landedIssue(1, F4, ['The owner sees no archived project waiting']);
    await recordRelease([shipped], '0.22.0');
    await ok(
      api(world.token, 'POST', `/api/issues/${shipped}/verdicts`, {
        criterion: 1,
        verdict: 'skipped',
        reason: 'no credential reads the owner attention page',
        identity: { kind: 'release', version: '0.22.0' },
      }),
    );

    const answer = await verdictOf(b);
    expect(answer.work).toMatchObject({ admissible: 0, owed: 0 });
    expect(answer.verdict).toMatchObject({ act: 'keep', drain: true });
    expect(answer.work.nudge).toContain(`ISS-1 ${shipped}`);
    expect(answer.work.nudge).toContain('no credential reads the owner attention page');
    expect(answer.work.nudge).not.toContain('--role qa');
  });
});

describe("ISS-1223: a criterion an owner's decision accepts on a named proof owes no live verdict", () => {
  const DECIDED = [
    { key: 'decision', value: 'Criteria with no runtime verdict count as proven by the suite' },
    {
      key: 'why',
      value: `The suite passed at ${LATER.slice(0, 8)}, which equals the production build`,
    },
  ];

  const decide = async (issueId: string) =>
    String(
      (
        await ok(
          api(world.token, 'POST', `/api/issues/${issueId}/events`, {
            kind: 'decision',
            contract: 1,
            fields: DECIDED,
          }),
        )
      ).id,
    );

  const accept = (issueId: string, acceptedOn: string, over: Doc = {}) =>
    api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: `The suite passed at ${LATER.slice(0, 8)}.`,
      identity: { kind: 'commit', sha: LATER },
      acceptedOn,
      ...over,
    });

  const verdictRows = async (issueId: string) =>
    Number(
      (
        (await db.execute(
          sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${issueId}`,
        )) as unknown as Array<{ n: number }>
      )[0]?.n,
    );

  const refusedAs = (res: { status: number; body: Record<string, unknown> }) => {
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    return (res.body as { error?: { refusals?: Array<{ code: string }> } }).error?.refusals?.map(
      (r) => r.code,
    );
  };

  /** catalog-api's shape: judged on production's running build, shipped 0.6.0 at F4, LATER holding it. */
  async function shippedOnTesting(): Promise<{
    b: Awaited<ReturnType<typeof box>>;
    shipped: string;
  }> {
    await seedLandedWorld();
    await externalProduction(true, 'production');
    const b = await box();
    const shipped = await landedIssue(1, F4, ['A buyer sees the catalog price']);
    await ok(
      api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
        issueIds: [shipped],
        version: '0.6.0',
        commit: F4,
        account: ACCOUNT,
      }),
    );
    await laterLanding(LATER);
    return { b, shipped };
  }

  it('reads the release accepted on the decision, never proven, and the master owes nothing', async () => {
    const { b, shipped } = await shippedOnTesting();
    expect((await verdictOf(b)).work).toMatchObject({ owed: 1 });

    const decision = await decide(shipped);
    const res = await accept(shipped, decision);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const release = (await ok(
      api(world.token, 'GET', `/api/projects/${world.projectId}/releases/0.6.0`),
    )) as Doc;
    const read = (release.release ?? release) as {
      verified: { proven: number; total: number };
      issueCriteria: Array<{ criteria: Array<Doc & { unverified: string | null }> }>;
    };
    expect(read.verified).toMatchObject({ proven: 0, total: 1 });
    const [criterion] = read.issueCriteria.flatMap((i) => i.criteria);
    expect(criterion).toMatchObject({ standing: 'accepted', proven: false, acceptedOn: decision });
    expect(criterion?.unverified).toContain(decision);

    const answer = await verdictOf(b);
    expect(answer.work).toMatchObject({ admissible: 0, owed: 0 });
    expect(answer.work.nudge).not.toContain(`ISS-1 ${shipped}`);
    expect(answer.work.nudge).not.toContain('--role qa');
  });

  it('refuses by name an acceptance naming what cannot be placed, and writes nothing', async () => {
    const { shipped } = await shippedOnTesting();
    const decision = await decide(shipped);
    const other = await landedIssue(2, F4, ['Another issue']);
    const elsewhere = await decide(other);
    const withdrawn = await decide(shipped);
    await ok(
      api(world.token, 'POST', `/api/issues/${shipped}/events/${withdrawn}/withdraw`, {
        reason: 'Recorded on the wrong criterion',
      }),
    );
    const events = (await ok(api(world.token, 'GET', `/api/issues/${shipped}/events`))) as {
      items: Array<{ id: string; kind: string }>;
    };
    const notDecision = events.items.find((e) => e.kind !== 'decision')?.id ?? '';
    expect(notDecision).not.toBe('');

    expect(refusedAs(await accept(shipped, elsewhere))).toEqual([
      'VERDICT_ACCEPTANCE_NOT_DECISION',
    ]);
    expect(refusedAs(await accept(shipped, notDecision))).toEqual([
      'VERDICT_ACCEPTANCE_NOT_DECISION',
    ]);
    expect(refusedAs(await accept(shipped, withdrawn))).toEqual([
      'VERDICT_ACCEPTANCE_NOT_DECISION',
    ]);
    expect(refusedAs(await accept(shipped, decision, { verdict: 'fail' }))).toEqual([
      'VERDICT_ACCEPTANCE_NOT_PASS',
    ]);
    expect(
      refusedAs(await accept(shipped, decision, { identity: { kind: 'runtime', ref: F4 } })),
    ).toEqual(['VERDICT_ACCEPTANCE_NOT_COMMIT']);
    expect(
      refusedAs(await accept(shipped, decision, { identity: { kind: 'commit', sha: ASIDE } })),
    ).toEqual([expect.stringMatching(/^VERDICT_COMMIT_(OFF_LANDING|UNPLACED)$/)]);
    expect(refusedAs(await accept(shipped, decision, { criterion: 9 }))).toEqual([
      'VERDICT_CRITERION_UNKNOWN',
    ]);
    expect(await verdictRows(shipped)).toBe(0);
  });
});
