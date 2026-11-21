/**
 * ISS-1387 rework: sidpeak's beta issues were ported as Feedback items, triaged into dev issues, and
 * one fire closed every pair whose dev twin a release closed. Every fire after it named none of them,
 * whether beta stood closed or a person had moved the row since, so the report could not tell a pair
 * in step from one passed over. Here, in sidpeak's shape (Feedback pairs, a beta that closes only once
 * a merge mark is recorded): a close names the dev release that shipped the twin, every later fire
 * accounts for each pair it owed nothing, a pair whose beta row was moved back since is held by name
 * with why, and the pair whose twin still waits on its release is left at awaiting_release.
 * forge-beta is the stub HTTP server of `beta-port-world.ts`. Against real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/mirror.ts
 * @direct-test-of packages/core/src/beta-port/mirror-close.ts
 * @direct-test-of packages/core/src/beta-port/markers.ts
 * @direct-test-of packages/core/src/beta-port/report.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  fireOnce,
  putBetaSecret,
  type Say,
  setDevStatus,
} from '../helpers/beta-port-harness.js';
import {
  beta,
  betaIssue,
  outsideGitDocument,
  RULING_AT,
  type StubIssue,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, ok, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

let say: Say;
let twin = { id: '', slug: '' };
let betaProjectId = '';
let scheduleId = '';

beforeAll(async () => {
  testEnv();
  const baseUrl = await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  const scheduleProjectId = (await createTestProject(ownerId)).id;
  const t = await createTestProject(ownerId);
  twin = { id: t.id, slug: t.slug };
  say = requester(app, { owner: await signUserToken(ownerId) }) as Say;
  betaProjectId = randomUUID();
  beta.projects = [{ id: betaProjectId, slug: twin.slug }];
  beta.configs.set(betaProjectId, outsideGitDocument());
  beta.issues.set(betaProjectId, []);
  // sidpeak's beta closes an issue only once its merge mark is recorded
  beta.closeNeedsMark = true;
  scheduleId = await betaPortScheduleOn(say, scheduleProjectId);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-url', baseUrl);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-token', TOKEN);
  await writeRuling(scheduleProjectId, RULING_AT);
}, 120_000);

afterAll(async () => {
  beta.closeNeedsMark = false;
  await stopBeta();
  await closeWorld();
});

const fire = async () => {
  const done = await fireOnce(say, scheduleId);
  // a fire that changed nothing is answered skipped, its report kept all the same
  expect(['success', 'skipped'], JSON.stringify(done)).toContain(done.status);
  return done.output ?? '';
};
const movesOf = (b: StubIssue) =>
  beta.transitions.filter((t) => t.issueId === b.id).map((t) => t.toStatus);

/** The dev issue the Feedback item a beta issue was ported as is triaged into: its id and key. */
async function carrierOf(b: StubIssue): Promise<{ id: string; key: string }> {
  const [item] = await rows<{ fb_seq: number }>(
    sql`SELECT f.fb_seq FROM beta_port_pairs p JOIN feedback f ON f.id = p.dev_feedback_id WHERE p.beta_issue_id = ${b.id}`,
  );
  if (!item) throw new Error(`beta ${b.displayId} was not ported as Feedback`);
  const triaged = ok(
    await say('owner', 'POST', `/api/projects/${twin.id}/feedback/FB-${item.fb_seq}/triage`, {
      answers: TRIAGE_ANSWERS,
      route: 'issue',
      createIssue: { title: `Fix what beta ${b.displayId} asks` },
    }),
  );
  const key = (triaged.feedback as { route: { carriers: { key: string }[] } }).route.carriers[0]
    ?.key as string;
  const [issue] = await rows<{ id: string }>(
    sql`SELECT id FROM issues WHERE project_id = ${twin.id} AND iss_seq = ${Number(key.slice(4))}`,
  );
  return { id: issue?.id as string, key };
}

/** Dev issues closed by one dev release `version`, as dev's release finish leaves them. */
async function releaseOnDev(version: string, devIds: string[]): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  const note = { section: 'Fixed', userFacing: 'The supplier page shows its mapping menu.' };
  for (const id of devIds) {
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE issues SET status = 'closed', merged_at = now(), merged_landing = 'https://dev.example/landed', release_notes = ${JSON.stringify(note)}::jsonb WHERE id = ${id}`,
      ),
    );
  }
  const at = new Date().toISOString();
  const metadata = {
    source: 'release-batch',
    issueIds: devIds,
    finish: { state: 'finished', commit: 'feed0000feed0000feed0000feed0000feed0000' },
  };
  await rows(
    sql`INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
        VALUES (${randomUUID()}, ${twin.id}, 'system', 'completed', ${at}, ${at}, ${version}, ${at}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}

describe("sidpeak's Feedback pairs are each accounted for on every fire (ISS-1387)", () => {
  it('closes citing the release, then names every pair it owed nothing, and holds one moved back by name', async () => {
    const landed = betaIssue(628);
    const open = betaIssue(639);
    const building = betaIssue(645);
    beta.issues.get(betaProjectId)?.push(landed, open, building);
    await fire();
    const [i21, i34, i42] = [
      await carrierOf(landed),
      await carrierOf(open),
      await carrierOf(building),
    ];
    // two twins land and wait on their release; beta follows them to awaiting_release
    await setDevStatus(i21.id, 'awaiting_release');
    await setDevStatus(i42.id, 'awaiting_release');
    await fire();
    expect(landed.status).toBe('awaiting_release');
    expect(building.status).toBe('awaiting_release');

    // a release closes two twins; the third is the next release's
    await releaseOnDev('0.29.0', [i21.id, i34.id]);
    const closing = await fire();
    expect(closing).toContain(
      `${twin.slug}: ${i21.key}: awaiting_release → closed (beta ISS-628), its landing recorded as forge-dev ${i21.key} at https://dev.example/landed, shipped in forge-dev release 0.29.0`,
    );
    expect(closing).toContain(`${twin.slug}: ${i34.key}: open → closed (beta ISS-639)`);
    expect(closing).toMatch(/ISS-639\), its landing .*, shipped in forge-dev release 0\.29\.0/);
    expect(landed.status).toBe('closed');
    expect(open.status).toBe('closed');
    expect(beta.transitions.filter((t) => t.issueId === landed.id).at(-1)?.reason).toBe(
      `Mirrored from forge-dev ${i21.key}, which moved to closed, shipped in forge-dev release 0.29.0.`,
    );
    // the twin still building is left as it is
    expect(movesOf(building)).toEqual(['awaiting_release']);

    // a fire with nothing to do names each pair it owed nothing, by its beta key and status
    const quiet = await fire();
    expect(quiet, quiet).toMatch(
      new RegExp(`pairs owing nothing \\(1\\):\\n  ${twin.slug}: 3 \\(`),
    );
    for (const said of [
      'beta ISS-628 at closed',
      'beta ISS-639 at closed',
      'beta ISS-645 at awaiting_release',
    ]) {
      expect(quiet).toContain(said);
    }
    expect(quiet).toContain('mirrored: none');

    // a person moves a closed row back on beta: the mirror leaves it, and says so by name
    landed.status = 'awaiting_release';
    const moved = await fire();
    expect(moved).toContain(
      `${twin.slug}: ${i21.key} at closed: beta ISS-628 stands at awaiting_release; the last try (closed) left beta at closed and it was moved to awaiting_release on beta since, so it is not moved again`,
    );
    expect(moved).toContain(`${twin.slug}: 2 (`);
    expect(moved).not.toContain('beta ISS-628 at awaiting_release');
    expect(movesOf(landed).filter((s) => s === 'closed')).toHaveLength(2);
    expect(movesOf(building)).toEqual(['awaiting_release']);
  });
});
