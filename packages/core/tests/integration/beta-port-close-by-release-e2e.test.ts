/**
 * ISS-1005: a dev release closes a ported twin, and its forge-beta issue closes by the release beta
 * takes. Beta, like dev, closes an issue only by a release, so the mirror records the dev release on
 * beta through the door forge-beta serves for a release already performed (`POST
 * /api/projects/:id/release-records`, forge-beta 51939268): the beta issue at its release gate, merge
 * marked and given the twin's release note, every one of which that door requires. Where beta
 * refuses the record, the refusal is commented on the beta issue by name once, the close stays owed,
 * and a later fire closes it once beta takes the record. A pair already closed is left alone.
 * forge-beta is the stub HTTP server of `beta-port-world.ts`. Against real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/mirror.ts
 * @direct-test-of packages/core/src/beta-port/markers.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/client.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/index.ts
 * @direct-test-of packages/core/src/db/schema-beta-port.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  fireOnce,
  putBetaSecret,
  type Say,
  seedTwin,
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
import { closeWorld, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

let say: Say;
let ownerId = '';
let scheduleId = '';

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

beforeEach(() => {
  beta.closeNeedsMark = false;
  beta.closeAfterMark.clear();
  beta.releaseGate.clear();
  beta.refuseRecord = null;
});

const fire = () => fireOnce(say, scheduleId);

const RELEASE_COMMIT = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const NOTE = { section: 'Fixed', userFacing: 'Orders show the right total again.' };

const pairOf = async (betaId: string) =>
  (
    await rows<{
      dev_issue_id: string;
      last_tried_status: string | null;
      beta_reached: string | null;
      close_refused: string | null;
    }>(
      sql`SELECT dev_issue_id, last_tried_status, beta_reached, close_refused FROM beta_port_pairs WHERE beta_issue_id = ${betaId}`,
    )
  )[0];

/** A dev twin of a beta project whose work lands outside git, with these beta issues ported to it. */
async function twinOf(issues: StubIssue[]) {
  const dev = await createTestProject(ownerId);
  const betaId = randomUUID();
  beta.projects.push({ id: betaId, slug: dev.slug });
  beta.configs.set(betaId, outsideGitDocument());
  beta.issues.set(betaId, issues);
  const keys = new Map<string, string>();
  for (const b of issues) {
    // a dev issue enters closed only by its release (`releaseOnDev`), so a closed beta's twin waits
    const at = b.status === 'closed' ? 'awaiting_release' : b.status;
    keys.set(b.id, (await seedTwin(say, dev, b, at)).key);
  }
  return { dev, betaId, keys };
}

/**
 * Each beta issue's dev twin closed by one dev release `version`: merge-marked, noted, and carried by
 * a finished release batch run at `RELEASE_COMMIT`, as dev's release finish leaves them.
 */
async function releaseOnDev(projectId: string, version: string, betaIssues: StubIssue[]) {
  const devIds: string[] = [];
  for (const b of betaIssues) devIds.push((await pairOf(b.id))?.dev_issue_id as string);
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  for (const id of devIds) {
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE issues SET status = 'closed', merged_at = now(), merged_landing = 'https://dev.example/landed', release_notes = ${JSON.stringify(NOTE)}::jsonb WHERE id = ${id}`,
      ),
    );
  }
  const at = new Date().toISOString();
  const metadata = {
    source: 'release-batch',
    issueIds: devIds,
    finish: { state: 'finished', commit: RELEASE_COMMIT },
  };
  await rows(
    sql`INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
        VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', ${at}, ${at}, ${version}, ${at}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}

const commentsOn = (b: StubIssue) => beta.comments.get(b.id) ?? [];
const recordsOf = (b: StubIssue) =>
  beta.records.filter((r) => (r.body.issueIds as string[]).includes(b.id));

describe('a dev release closes its beta twin by a release record (ISS-1005)', () => {
  it('a beta refusing a plain close (CLOSE_ONLY_BY_RELEASE, or holding it at its release gate) takes the dev release as a record, and the beta issue closes by it', async () => {
    const refusing = betaIssue(60, { status: 'in_progress' });
    const gated = betaIssue(61, { status: 'in_progress' });
    const { dev, keys } = await twinOf([refusing, gated]);
    await releaseOnDev(dev.id, '0.21.0', [refusing, gated]);
    beta.closeNeedsMark = true;
    beta.closeAfterMark.set(refusing.id, 'CLOSE_ONLY_BY_RELEASE');
    // a beta holding an agent's close at its gate stores awaiting_release and answers 200, which the
    // mirror reads instead of taking it as closed
    beta.releaseGate.add(gated.id);
    const commentsBefore = [refusing, gated].map((b) => commentsOn(b).length);

    const first = await fire();
    expect([refusing.status, gated.status]).toEqual(['closed', 'closed']);
    expect(beta.transitions.filter((t) => t.issueId === gated.id).map((t) => t.toStatus)).toEqual([
      'closed',
    ]);

    for (const b of [refusing, gated]) {
      const [record] = recordsOf(b);
      expect(recordsOf(b)).toHaveLength(1);
      expect(record?.refused).toBeNull();
      expect(record?.body.issueIds).toEqual([b.id]);
      expect(record?.body.commit).toBe(RELEASE_COMMIT);
      expect(record?.body.providerRef).toBe(`forge-dev ${dev.slug} 0.21.0`);
      expect(String(record?.body.account)).toContain(`${dev.slug} 0.21.0`);
      expect(String(record?.body.account)).toContain(keys.get(b.id));
      // what beta's record requires: its merge mark and the twin's note
      expect(beta.marks.get(b.id)?.landing).toBe(
        `forge-dev ${keys.get(b.id)} at https://dev.example/landed`,
      );
      expect(beta.notes.get(b.id)).toEqual({ section: NOTE.section, userFacing: NOTE.userFacing });
      expect(await pairOf(b.id)).toMatchObject({
        last_tried_status: 'closed',
        beta_reached: 'closed',
        close_refused: null,
      });
      expect(first.output).toContain(
        `${dev.slug}: ${keys.get(b.id)}: in_progress → closed (beta ${b.displayId}), its landing recorded as forge-dev ${keys.get(b.id)} at https://dev.example/landed, by forge-dev release 0.21.0 recorded on beta`,
      );
    }
    expect([refusing, gated].map((b) => commentsOn(b).length)).toEqual(commentsBefore);
  });

  it('a beta refusing the record is commented once by name, the close stays owed, and a later fire closes it once beta takes the record', async () => {
    const b = betaIssue(62, { status: 'in_progress' });
    const { dev, keys } = await twinOf([b]);
    await releaseOnDev(dev.id, '0.22.0', [b]);
    beta.closeAfterMark.set(b.id, 'CLOSE_ONLY_BY_RELEASE');
    beta.closeNeedsMark = true;
    beta.refuseRecord = 'RELEASE_NOT_VERIFIED';

    const first = await fire();
    expect(b.status).toBe('awaiting_release');
    expect(recordsOf(b).map((r) => r.refused)).toEqual(['RELEASE_NOT_VERIFIED']);
    const said = commentsOn(b).filter((c) => c.includes('forge-beta refused to close'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`forge-dev ${keys.get(b.id)} was closed by its release 0.22.0`);
    expect(said[0]).toContain('recording forge-dev release 0.22.0: RELEASE_NOT_VERIFIED');
    expect(first.output).toContain(
      `${dev.slug}: ${keys.get(b.id)} → beta ${b.displayId} closed: CLOSE_REQUIRES_SHIPPED, after the landing was recorded: CLOSE_ONLY_BY_RELEASE, recording forge-dev release 0.22.0: RELEASE_NOT_VERIFIED`,
    );
    expect(first.output).toContain('RELEASE_NOT_VERIFIED');
    expect((await pairOf(b.id))?.close_refused).toContain('RELEASE_NOT_VERIFIED');

    // beta still refuses: tried again, named in the report, and not commented again
    const second = await fire();
    expect(recordsOf(b).map((r) => r.refused)).toEqual([
      'RELEASE_NOT_VERIFIED',
      'RELEASE_NOT_VERIFIED',
    ]);
    expect(second.output).toContain('RELEASE_NOT_VERIFIED');
    expect(commentsOn(b).filter((c) => c.includes('forge-beta refused to close'))).toHaveLength(1);
    expect(b.status).toBe('awaiting_release');

    // beta takes the record now: the close it owed lands, still with one comment
    beta.refuseRecord = null;
    const third = await fire();
    expect(b.status).toBe('closed');
    expect(recordsOf(b).map((r) => r.refused)).toEqual([
      'RELEASE_NOT_VERIFIED',
      'RELEASE_NOT_VERIFIED',
      null,
    ]);
    expect(third.output).toContain(
      `${keys.get(b.id)}: awaiting_release → closed (beta ${b.displayId}), by forge-dev release 0.22.0 recorded on beta`,
    );
    expect(commentsOn(b).filter((c) => c.includes('forge-beta refused to close'))).toHaveLength(1);
    expect(await pairOf(b.id)).toMatchObject({ beta_reached: 'closed' });

    // closed: nothing more is sent
    const records = beta.records.length;
    const moves = beta.transitions.length;
    await fire();
    expect(beta.records).toHaveLength(records);
    expect(beta.transitions).toHaveLength(moves);
  });

  it('a pair already closed on beta is untouched, whoever closed it', async () => {
    const mirrored = betaIssue(63, { status: 'closed' });
    const byHand = betaIssue(64, { status: 'closed' });
    const { dev } = await twinOf([mirrored, byHand]);
    await releaseOnDev(dev.id, '0.23.0', [mirrored, byHand]);
    await rows(
      sql`UPDATE beta_port_pairs SET last_tried_status = 'closed', beta_reached = 'closed', last_mirrored_status = 'closed' WHERE beta_issue_id = ${mirrored.id}`,
    );
    // the mirror left it at the gate; a person closed it on beta since
    await rows(
      sql`UPDATE beta_port_pairs SET last_tried_status = 'closed', beta_reached = 'awaiting_release' WHERE beta_issue_id = ${byHand.id}`,
    );
    const moves = beta.transitions.length;
    const marks = beta.marks.size;
    const records = beta.records.length;
    const comments = [mirrored, byHand].map((b) => commentsOn(b).length);

    await fire();

    expect(beta.transitions.slice(moves)).toEqual([]);
    expect(beta.marks.size).toBe(marks);
    expect(beta.records).toHaveLength(records);
    expect(beta.notes.has(mirrored.id) || beta.notes.has(byHand.id)).toBe(false);
    expect([mirrored, byHand].map((b) => commentsOn(b).length)).toEqual(comments);
    expect([mirrored.status, byHand.status]).toEqual(['closed', 'closed']);
  });
});
