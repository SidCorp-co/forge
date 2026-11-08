/**
 * ISS-988: a release pressed on a beta twin project reaches dev. The beta port takes it once,
 * maps its beta issues to their dev twins, and cuts it through dev's own release door, named for
 * the beta release, once every dev issue stands at dev's release gate. It never cuts a partial
 * roster, and it names each beta issue with no dev twin. Once the dev release ships or fails, it
 * writes the outcome back on beta once: the beta release is ended with a reason naming the dev
 * release, and each beta issue gets one comment. A shipped issue then closes by that dev release
 * (ISS-1005's mirror). Nothing moves beta backward. forge-beta is the stub HTTP server of
 * `beta-port-world.ts`. Runs against real Postgres, with dev's real release door.
 *
 * @direct-test-of packages/core/src/beta-port/releases.ts
 * @direct-test-of packages/core/src/beta-port/release-store.ts
 * @direct-test-of packages/core/src/beta-port/run.ts
 * @direct-test-of packages/core/src/beta-port/report.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/releases.ts
 * @direct-test-of packages/core/src/schedules/beta-port-dispatch.ts
 * @direct-test-of packages/core/src/schedules/ports.ts
 * @direct-test-of packages/core/src/db/schema-beta-port.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  fireOnce,
  putBetaSecret,
  type Say,
  seedTwin,
  setDevStatus,
} from '../helpers/beta-port-harness.js';
import {
  beta,
  betaIssue,
  outsideGitDocument,
  pressRelease,
  RULING_AT,
  type StubIssue,
  type StubRelease,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let say: Say;
let ownerId = '';
let scheduleId = '';
let devProjectId = '';
const fx = releaseWorld(() => ({ projectId: devProjectId, ownerId }));

beforeAll(async () => {
  testEnv();
  const baseUrl = await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const scheduleProjectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) }) as Say;
  beta.projects = [];
  scheduleId = await betaPortScheduleOn(say, scheduleProjectId);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-url', baseUrl);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-token', TOKEN);
  await writeRuling(scheduleProjectId, RULING_AT);
}, 120_000);

afterAll(async () => {
  await stopBeta();
  await closeWorld();
});

const fire = () => fireOnce(say, scheduleId);

const RELEASE_COMMIT = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const NOTE = { section: 'Fixed', userFacing: 'Orders show the right total again.' };

/**
 * A dev twin project that releases through dev's own door, and a beta project of its slug. `twinned`
 * beta issues are ported as twins at `devStatus`, merged and noted; `untwinned` ones never were.
 */
async function world(twinned: StubIssue[], untwinned: StubIssue[] = [], devStatus?: string[]) {
  const dev = await createTestProject(ownerId);
  devProjectId = dev.id;
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId: dev.id, ownerId, bindingId, probes: 'none' });
  const betaId = randomUUID();
  beta.projects.push({ id: betaId, slug: dev.slug });
  beta.configs.set(betaId, outsideGitDocument());
  beta.issues.set(betaId, [...twinned, ...untwinned]);
  const devIds = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const [i, b] of twinned.entries()) {
    const twin = await seedTwin(say, dev, b, devStatus?.[i] ?? 'awaiting_release');
    devIds.set(b.id, twin.id);
    keys.set(b.id, twin.key);
    await rows(
      sql`UPDATE issues SET merged_at = now(), merged_landing = 'https://dev.example/landed', release_notes = ${JSON.stringify(NOTE)}::jsonb WHERE id = ${twin.id}`,
    );
  }
  return { dev, betaId, devIds, keys };
}

interface DevRun {
  id: string;
  status: string;
  version: string;
  name: string | null;
  summary: string | null;
  issue_ids: string[];
}

const devReleases = (projectId: string) =>
  rows<DevRun>(
    sql`SELECT id, status, release_version AS version, metadata -> 'naming' ->> 'name' AS name,
               metadata -> 'naming' ->> 'summary' AS summary, metadata -> 'issueIds' AS issue_ids
          FROM pipeline_runs WHERE project_id = ${projectId} AND metadata ->> 'source' = 'release-batch'
         ORDER BY started_at`,
  );

const takenRow = async (release: StubRelease) =>
  (
    await rows<{
      state: string;
      dev_run_id: string | null;
      told: string[];
      written_back_at: unknown;
    }>(
      sql`SELECT state, dev_run_id, told, written_back_at FROM beta_port_releases WHERE beta_run_id = ${release.runId}`,
    )
  )[0];

/** The dev release shipped, as dev's release finish leaves it: its twins closed by it. */
async function shipOnDev(run: DevRun, devIssueIds: string[]) {
  const { stampReleaseShipped } = await import('../../src/pipeline/run-records.js');
  const { closeRunIfOneShot } = await import('../../src/pipeline/index.js');
  const { releaseEndedRunClaims } = await import('../../src/issues/index.js');
  await rows(
    sql`UPDATE pipeline_runs SET metadata = metadata || ${JSON.stringify({ finish: { state: 'finished', commit: RELEASE_COMMIT } })}::jsonb WHERE id = ${run.id}`,
  );
  for (const id of devIssueIds) await setDevStatus(id, 'closed');
  await stampReleaseShipped(run.id);
  await closeRunIfOneShot(run.id, 'completed');
  await releaseEndedRunClaims();
}

const commentsOn = (b: StubIssue) => beta.comments.get(b.id) ?? [];

describe('a release pressed on beta is run on dev and written back once (ISS-988)', () => {
  it('reaches dev as a release cut through its own door, named for the beta release; once it ships, beta is ended and told once, and its issues close by it', async () => {
    const one = betaIssue(80, { status: 'awaiting_release', mergedAt: new Date().toISOString() });
    const two = betaIssue(81, { status: 'awaiting_release', mergedAt: new Date().toISOString() });
    const { dev, betaId, devIds } = await world([one, two]);
    const pressed = pressRelease(betaId, [one, two], { version: '0.3.7' });
    // beta holds a plain close at its release gate, so each closes only by a release record, which
    // beta refuses while its own release still claims the issue
    beta.releaseGate.add(one.id);
    beta.releaseGate.add(two.id);

    const first = await fire();
    const [run, ...more] = await devReleases(dev.id);
    expect(more, 'one release is cut on dev').toEqual([]);
    expect(run?.status).toBe('running');
    expect([...(run?.issue_ids ?? [])].sort()).toEqual([...devIds.values()].sort());
    // the cut carries the naming: the beta release by version and id, and what it carries
    expect(run?.name).toBe('Beta 0.3.7 on dev');
    expect(run?.summary).toContain(`forge-beta release 0.3.7 (${pressed.runId})`);
    expect(run?.summary).toContain('It carries 2 dev issues.');
    expect(first.output).toContain(
      `${dev.slug}: forge-beta release 0.3.7 (${pressed.runId}) requested on dev as ${run?.version}, carrying 2 dev issues`,
    );
    expect(await takenRow(pressed)).toMatchObject({ state: 'requested', dev_run_id: run?.id });
    expect(pressed.aborts).toEqual([]);

    // still running on dev: taken once, nothing cut again, nothing written back
    await fire();
    expect(await devReleases(dev.id)).toHaveLength(1);
    expect(pressed.aborts).toEqual([]);
    expect([one, two].map((b) => commentsOn(b).length)).toEqual([0, 0]);

    await shipOnDev(run as DevRun, [...devIds.values()]);
    const settled = await fire();
    expect(pressed.status).toBe('aborted');
    expect(pressed.aborts).toEqual([
      `Run on forge-dev as ${dev.slug} ${run?.version}, which shipped; each issue it carries closes by that release.`,
    ]);
    for (const b of [one, two]) {
      const told = commentsOn(b).filter((c) => c.includes(`forge-dev release ${dev.slug}`));
      expect(told).toEqual([
        `Released by forge-dev release ${dev.slug} ${run?.version}, run for forge-beta release 0.3.7; this issue closes by that release.`,
      ]);
      // ended on beta first, so the mirror's close by the dev release is taken in the same fire
      expect(b.status).toBe('closed');
    }
    expect(settled.output).toContain(
      `forge-beta release 0.3.7 (${pressed.runId}): dev ${run?.version} shipped, written back on beta`,
    );
    expect((await takenRow(pressed))?.written_back_at).not.toBeNull();

    // written back once: no second end, no second comment
    const comments = [one, two].map((b) => commentsOn(b).length);
    await fire();
    expect(pressed.aborts).toHaveLength(1);
    expect([one, two].map((b) => commentsOn(b).length)).toEqual(comments);
  });

  it('names a beta issue with no dev twin, in the report and in the release request, and cuts nothing for a release none of whose issues has one', async () => {
    const twinned = betaIssue(82, { status: 'awaiting_release' });
    const orphan = betaIssue(83, { status: 'awaiting_release' });
    const alone = betaIssue(84, { status: 'awaiting_release' });
    const { dev, betaId } = await world([twinned], [orphan, alone]);
    const mixed = pressRelease(betaId, [twinned, orphan], { version: '0.3.8' });
    const bare = pressRelease(betaId, [alone], { version: '0.3.9' });

    const first = await fire();
    expect(first.output).toContain(
      `${dev.slug}: forge-beta release 0.3.8 (${mixed.runId}): beta ${orphan.displayId} (never ported to dev)`,
    );
    expect(first.output).toContain(
      `${dev.slug}: forge-beta release 0.3.9 (${bare.runId}) taken: no beta issue it carries has a dev twin, so nothing is cut`,
    );
    expect(first.output).toContain(`beta ${alone.displayId} (never ported to dev)`);
    const cuts = await devReleases(dev.id);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.summary).toContain('It carries 1 dev issue');
    expect(cuts[0]?.summary).toContain(`beta ${orphan.displayId} (never ported to dev)`);
    expect((await takenRow(bare))?.state).toBe('no_twin');

    // taken once: a later fire neither takes nor names them again
    const second = await fire();
    expect(second.output).not.toContain(`(${bare.runId}) taken`);
    expect(await devReleases(dev.id)).toHaveLength(1);
  });

  it('cuts no partial roster: waits, naming each dev issue not at the release gate, and cuts once all are', async () => {
    const ready = betaIssue(85, { status: 'awaiting_release' });
    const behind = betaIssue(86, { status: 'awaiting_release' });
    const { dev, betaId, devIds, keys } = await world(
      [ready, behind],
      [],
      ['awaiting_release', 'in_progress'],
    );
    const pressed = pressRelease(betaId, [ready, behind], { version: '0.4.0' });

    const first = await fire();
    expect(await devReleases(dev.id)).toEqual([]);
    expect(first.output).toContain(
      `${dev.slug}: forge-beta release 0.4.0 (${pressed.runId}): not every dev issue is at awaiting_release: ${keys.get(behind.id)} at in_progress; nothing cut`,
    );
    expect((await takenRow(pressed))?.state).toBe('waiting');

    await setDevStatus(devIds.get(behind.id) as string, 'awaiting_release');
    await fire();
    const [run] = await devReleases(dev.id);
    expect([...(run?.issue_ids ?? [])].sort()).toEqual([...devIds.values()].sort());
  });

  it('a dev release that fails ends the beta release naming it and tells each issue once, moving no beta issue', async () => {
    const b = betaIssue(87, { status: 'awaiting_release' });
    const { dev, betaId } = await world([b]);
    const old = pressRelease(betaId, [b], {
      version: '0.2.0',
      startedAt: new Date(RULING_AT.getTime() - 60_000).toISOString(),
    });
    const pressed = pressRelease(betaId, [b], { version: '0.4.1' });

    await fire();
    // a release pressed before the ruling is beta's own: never taken
    expect(await takenRow(old)).toBeUndefined();
    const [run] = await devReleases(dev.id);
    const { closeRunIfOneShot } = await import('../../src/pipeline/index.js');
    await closeRunIfOneShot(run?.id as string, 'failed', { code: 'DEPLOY_FAILED', detail: 'no' });
    const moves = beta.transitions.length;

    const settled = await fire();
    expect(pressed.aborts).toEqual([
      `Run on forge-dev as ${dev.slug} ${run?.version}, which failed; nothing was released.`,
    ]);
    expect(commentsOn(b).filter((c) => c.includes(`forge-dev release ${dev.slug}`))).toEqual([
      `Not released: forge-dev release ${dev.slug} ${run?.version}, run for forge-beta release 0.4.1 failed, and this issue stays where it is.`,
    ]);
    expect(beta.transitions.slice(moves), 'nothing moves beta').toEqual([]);
    expect(b.status).toBe('awaiting_release');
    expect(settled.output).toContain(`dev ${run?.version} failed, written back on beta`);
    expect(old.aborts).toEqual([]);

    await fire();
    expect(pressed.aborts).toHaveLength(1);
    expect(commentsOn(b).filter((c) => c.includes(`forge-dev release ${dev.slug}`))).toHaveLength(
      1,
    );
  });
});
