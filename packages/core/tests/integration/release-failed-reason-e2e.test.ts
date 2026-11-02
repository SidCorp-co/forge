/**
 * ISS-761: a release never reads `failed` with nothing on record to say why. catalog-api's 0.4.0
 * (2026-10-29) read failed with no refusal and no abort reason, though its verify attempt read ok:
 * the close that failed it wrote its cause onto the run (`metadata.failure`), and the release read
 * only the finish refusal and the abort stamp. Planted here through the app's own doors against real
 * Postgres: a recorded release one of whose issues will not close, a release run closed `completed`
 * with no ship, one cancelled with no abort; the person's abort, which keeps its person and reason;
 * and the admin's repair of a failed release that did ship, kept beside the failure it settles.
 *
 * @direct-test-of packages/core/src/pipeline/runs-cascade.ts
 * @direct-test-of packages/core/src/release-batch/release-repair.ts
 * @direct-test-of packages/core/src/release-batch/release-cuts.ts
 * @direct-test-of packages/core/src/release-batch/recorded.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeRunIfOneShot } from '../../src/pipeline/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import {
  F4,
  judgedAll,
  landedIssue,
  record,
  refusalsOf,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';
import { declareProductionDocument, releaseWorld, seedProduction } from '../helpers/release-world.js';

type Cut = {
  runId: string;
  version: string;
  outcome: string;
  refusal: { code: string | null; text: string } | null;
  abortReason: string | null;
  failure: { code: string; detail: string; step: string | null } | null;
  repair: {
    outcome: string;
    by: { id: string } | null;
    reason: string;
    evidence: string;
    was: { status: string; failureCode: string | null };
  } | null;
  decidedBy: { id: string } | null;
};

async function releasePage(token: string, projectId: string, version: string) {
  const r = await api(token, 'GET', `/api/projects/${projectId}/releases/${version}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.release as { state: string; cuts: Cut[] };
}

/** The attempt wearing `version`, and whatever on it says why it ended. */
async function ownCut(token: string, projectId: string, version: string) {
  const page = await releasePage(token, projectId, version);
  const cut = page.cuts.find((c) => c.version === version) as Cut;
  return { state: page.state, cut, why: cut.refusal ?? cut.abortReason ?? cut.failure ?? null };
}

const runStatus = async (runId: string) => {
  const [row] = (await db.execute(
    sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
  )) as unknown as Array<{ status: string }>;
  return row?.status;
};

const PLANTED = 'iss761_refuse_close';

/** The issue that will not close: every write moving it to `closed` raises, as a refused close does. */
async function plantRefusedClose(issueId: string): Promise<void> {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION ${PLANTED}() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'closed' AND NEW.id = '${issueId}'::uuid THEN
          RAISE EXCEPTION 'planted: issue ${issueId} will not close';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${PLANTED} BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION ${PLANTED}()`,
    ),
  );
}

afterEach(async () => {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${PLANTED} ON issues`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${PLANTED}()`));
});

describe('a recorded release one of whose issues will not close (catalog-api 0.4.0)', () => {
  beforeEach(async () => {
    await seedLandedWorld();
    await seedProduction({ projectId: world.projectId, ownerId: world.ownerId, probes: 'none' });
  });

  async function failedRecord(): Promise<{ runId: string; stuck: string }> {
    const done = await landedIssue(1, F4);
    const stuck = await landedIssue(2, F4);
    await judgedAll(done, F4);
    await judgedAll(stuck, F4);
    await plantRefusedClose(stuck);
    const res = await record([done, stuck], F4, { version: '0.4.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.failed).toEqual([expect.objectContaining({ id: stuck })]);
    return { runId: String(res.body.runId), stuck };
  }

  it('reads failed naming the close that failed it, its verify attempt kept as recorded', async () => {
    const { runId, stuck } = await failedRecord();

    const [attempt] = (await db.execute(
      sql`SELECT stage, verdict FROM release_attempts WHERE run_id = ${runId}`,
    )) as unknown as Array<{ stage: string; verdict: string }>;
    expect(attempt).toEqual({ stage: 'verify', verdict: 'recorded' });

    const { state, cut, why } = await ownCut(world.token, world.projectId, '0.4.0');
    expect(state).toBe('failed');
    expect(why, 'a failed release names why it failed').not.toBeNull();
    expect(cut.failure).toMatchObject({ code: 'release_record_incomplete' });
    expect(cut.failure?.detail).toContain(stuck);
  });

  it('is repaired to shipped by an admin, the failure kept beside the repair', async () => {
    const { runId } = await failedRecord();
    const repair = (body: unknown, token = world.token, version = '0.4.0') =>
      api(token, 'POST', `/api/projects/${world.projectId}/releases/${version}/repair`, body);
    const sent = {
      outcome: 'shipped',
      reason: 'It landed on release/production at 9216263b (!1023) and the deploy was healthy.',
      evidence: 'release_attempts verify ok on run; GitLab !1023 merged; deploy healthy',
    };

    const member = (await createTestUser({ verified: true })).id;
    await addProjectMember(world.projectId, member, 'member');
    expect((await repair(sent, await userToken(member))).status, 'a member is no admin').toBe(403);

    const shapeless = await repair({ outcome: 'shipped', reason: 'it shipped' });
    expect(refusalsOf(shapeless.body)[0]?.code).toBe('RELEASE_REPAIR_SHAPE');
    const unknown = await repair(sent, world.token, '9.9.9');
    expect(refusalsOf(unknown.body)[0]?.code).toBe('RELEASE_REPAIR_UNKNOWN');

    const done = await repair(sent);
    expect(done.status, JSON.stringify(done.body)).toBe(201);

    const { state, cut } = await ownCut(world.token, world.projectId, '0.4.0');
    expect(state).toBe('shipped');
    expect(cut.repair).toMatchObject({
      outcome: 'shipped',
      by: { id: world.ownerId },
      reason: sent.reason,
      evidence: sent.evidence,
      was: { status: 'failed', failureCode: 'release_record_incomplete' },
    });
    expect(cut.failure?.code, 'the repair hides nothing it settled').toBe(
      'release_record_incomplete',
    );
    expect(await runStatus(runId)).toBe('failed');

    const again = await repair(sent);
    expect(refusalsOf(again.body)[0]?.code).toBe('RELEASE_REPAIR_NOT_FAILED');
  });
});

describe('a release batch run closed without a ship or an abort', () => {
  let projectId: string;
  let ownerId: string;
  let token: string;
  const fx = releaseWorld(() => ({ projectId, ownerId }));

  beforeEach(async () => {
    await truncateAll();
    ownerId = (await createTestUser({ verified: true })).id;
    projectId = (await createTestProject(ownerId)).id;
    token = await userToken(ownerId);
    await fx.seedReleaseRunner();
    const bindingId = await fx.declareProduction({}, 'none');
    await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
  });

  async function cut(): Promise<{ runId: string; version: string }> {
    const issueIds = [await fx.insertIssue()];
    const r = await api(token, 'POST', `/api/projects/${projectId}/release-batches`, { issueIds });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { runId: String(r.body.runId), version: String(r.body.version) };
  }

  it('closed `completed` with nothing stamping its ship reads failed naming that', async () => {
    const { runId, version } = await cut();
    await closeRunIfOneShot(runId, 'completed');

    const { state, cut: own, why } = await ownCut(token, projectId, version);
    expect(state).toBe('failed');
    expect(why, 'a failed release names why it failed').not.toBeNull();
    expect(own.failure).toMatchObject({ code: 'release_not_shipped' });
    expect(own.failure?.detail).toContain(version);
    expect(await runStatus(runId)).toBe('failed');
  });

  it('cancelled with no abort reads failed naming that no abort said who or why', async () => {
    const { runId, version } = await cut();
    await closeRunIfOneShot(runId, 'cancelled');

    const { state, cut: own, why } = await ownCut(token, projectId, version);
    expect(state).toBe('failed');
    expect(why).not.toBeNull();
    expect(own.failure).toMatchObject({ code: 'release_cancelled_without_abort' });
  });

  it('aborted by a person keeps that person and the reason they gave, and no failure', async () => {
    const { runId, version } = await cut();
    const reason = 'The deploy target is down for maintenance; re-cut tomorrow.';
    const r = await api(token, 'POST', `/api/projects/${projectId}/release-batches/${runId}/abort`, {
      reason,
      pushed: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // the roster went back to the gate unpushed, so the page reads the draft that re-cuts it
    const page = await releasePage(token, projectId, version);
    const own = page.cuts.find((c) => c.runId === runId) as Cut;
    expect(own.outcome).toBe('aborted');
    expect(own.abortReason).toBe(reason);
    expect(own.decidedBy).toMatchObject({ id: ownerId });
    expect(own.failure).toBeNull();
    expect(await runStatus(runId)).toBe('cancelled');
  });
});
