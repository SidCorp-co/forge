/**
 * ISS-761: a release never reads `failed` with nothing on record to say why. catalog-api's 0.4.0
 * (2026-10-29) read failed with no refusal and no abort reason, though its verify attempt read ok:
 * the close that failed it wrote its cause onto the run (`metadata.failure`), and the release read
 * only the finish refusal and the abort stamp. Planted here through the app's own doors against real
 * Postgres: a recorded release none of whose issues will close, a release run closed `completed`
 * with no ship, one cancelled with no abort; the person's abort, which keeps its person and reason;
 * and the admin's repair of a failed release that did ship, kept beside the failure it settles.
 *
 * @direct-test-of packages/core/src/pipeline/runs-cascade.ts
 * @direct-test-of packages/core/src/release-batch/release-repair.ts
 * @direct-test-of packages/core/src/release-batch/repaired-roster.ts
 * @direct-test-of packages/core/src/release-batch/release-cuts.ts
 * @direct-test-of packages/core/src/release-batch/recorded.ts
 * @direct-test-of packages/core/src/pipeline/release-run-cancel.ts
 * @direct-test-of packages/core/src/pipeline/runs-control.ts
 * @direct-test-of packages/core/src/jobs/cancel-job.ts
 * @direct-test-of packages/core/src/agent-sessions/lifecycle-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeRunIfOneShot,
  stampReleaseShipped,
  writeRunMetadata,
} from '../../src/pipeline/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestDevice,
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
import {
  declareProductionDocument,
  releaseWorld,
  seedProduction,
} from '../helpers/release-world.js';

type Cut = {
  runId: string;
  version: string;
  outcome: string;
  refusal: { code: string | null; text: string } | null;
  abort: { recorded: true; reason: string } | { recorded: false; says: string } | null;
  failure: { code: string; detail: string; step: string | null } | null;
  repair: {
    at?: string;
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
  return { state: page.state, cut, why: cut.refusal ?? cut.abort ?? cut.failure ?? null };
}

const runStatus = async (runId: string) => {
  const [row] = (await db.execute(
    sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
  )) as unknown as Array<{ status: string }>;
  return row?.status;
};

const PLANTED = 'iss761_refuse_close';

/** The issues that will not close: every write moving one to `closed` raises, as a refused close does. */
async function plantRefusedClose(...issueIds: string[]): Promise<void> {
  const ids = issueIds.map((id) => `'${id}'::uuid`).join(', ');
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION ${PLANTED}() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'closed' AND NEW.id IN (${ids}) THEN
          RAISE EXCEPTION 'planted: issue % will not close', NEW.id;
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

// A record that closed none of its roster stands on nothing but the agent's word, so it ends `failed`
// naming each refusal, and the repair is that release's way to shipped. One that closed any of its
// roster ships, the rest its residue (ISS-928, `release-shipped-residue-e2e.test.ts`).
describe('a recorded release none of whose issues will close (catalog-api 0.4.0, as ISS-928 leaves it)', () => {
  beforeEach(async () => {
    await seedLandedWorld();
    await seedProduction({ projectId: world.projectId, ownerId: world.ownerId, probes: 'none' });
  });

  async function failedRecord(): Promise<{ runId: string; done: string; stuck: string }> {
    const done = await landedIssue(1, F4);
    const stuck = await landedIssue(2, F4);
    await judgedAll(done, F4);
    await judgedAll(stuck, F4);
    await plantRefusedClose(done, stuck);
    const res = await record([done, stuck], F4, { version: '0.4.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.failed).toEqual([
      expect.objectContaining({ id: done }),
      expect.objectContaining({ id: stuck }),
    ]);
    return { runId: String(res.body.runId), done, stuck };
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

    // asked again, a repaired release writes no second repair: it settles what its roster owes
    const again = await repair(sent);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ repeated: true, repair: { at: cut.repair?.at } });
  });

  // catalog-api ISS-34 (2026-11-02, on 5a9717d69): 0.4.0 repaired to shipped read landed, while its
  // roster issue stayed at awaiting_release reading shippedIn 0.4.0, nobody closing it. The repair
  // settles its roster as its finish would have.
  const SENT = {
    outcome: 'shipped',
    reason: 'It landed on release/production and the deploy was healthy.',
    evidence: 'release_attempts verify ok on run; deploy healthy',
  };
  const repaired = () =>
    api(world.token, 'POST', `/api/projects/${world.projectId}/releases/0.4.0/repair`, SENT);
  const issueRead = async (id: string) =>
    (await api(world.token, 'GET', `/api/issues/${id}`)).body as {
      status: string;
      shippedIn: { version: string } | null;
    };

  it('closes its roster issue into the repaired release, as the finish would have', async () => {
    const { done: first, stuck } = await failedRecord();
    // what would not close is cleared, as catalog-api's was by the time it was repaired
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${PLANTED} ON issues`));
    expect((await issueRead(stuck)).status).toBe('awaiting_release');

    const done = await repaired();
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.roster).toEqual({ closed: [first, stuck], heldForAgent: [] });
    expect(await issueRead(stuck)).toMatchObject({
      status: 'closed',
      shippedIn: { version: '0.4.0' },
    });
  });

  it('holds what it cannot close for its agent, named, and the same repair asked again closes it', async () => {
    const { done: first, stuck } = await failedRecord();
    const done = await repaired();
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const roster = done.body.roster as {
      closed: string[];
      heldForAgent: Array<{ issueId: string }>;
    };
    expect(roster.closed).toEqual([]);
    expect(roster.heldForAgent).toEqual([
      expect.objectContaining({ issueId: first }),
      expect.objectContaining({ issueId: stuck }),
    ]);
    expect((await issueRead(stuck)).status).toBe('awaiting_release');

    // ISS-34's shape: the release reads shipped, the issue waits. The same repair, asked again,
    // settles what the roster still owes and writes no second repair nor a second release record
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${PLANTED} ON issues`));
    const again = await repaired();
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({
      repeated: true,
      roster: { closed: [first, stuck], heldForAgent: [] },
    });
    expect((again.body.repair as { at: string }).at).toBe((done.body.repair as { at: string }).at);
    expect(await issueRead(stuck)).toMatchObject({
      status: 'closed',
      shippedIn: { version: '0.4.0' },
    });
  });
});

// catalog-api 0.4.0 live on 00d46345c: a recorded landing (no production environment) that ended failed
// was repaired by ISS-761's act, which wrote `metadata.repair` and stamped the ship but settled no
// roster, so it reads `landed` and ISS-34 waits at awaiting_release reading shippedIn 0.4.0. The repeat
// repair was refused RELEASE_REPAIR_NOT_FAILED: the not-failed guard ran before the repeat.
describe('a landing repaired by the earlier act, asked again (catalog-api ISS-34)', () => {
  beforeEach(async () => {
    await seedLandedWorld();
  });

  it('settles its roster on the repeat: 200, repeated, the issue closed into 0.4.0', async () => {
    const done = await landedIssue(1, F4);
    const stuck = await landedIssue(2, F4);
    // closing none, the landing ends failed as 0.4.0 did; one closing any would ship (ISS-928)
    await plantRefusedClose(done, stuck);
    const res = await record([done, stuck], F4, { version: '0.4.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const runId = String(res.body.runId);
    expect((await ownCut(world.token, world.projectId, '0.4.0')).state).toBe('failed');

    // the repair as ISS-761 wrote it: the repair kept on the run and the ship stamped, no roster settled
    const earlier = {
      outcome: 'shipped',
      by: world.ownerId,
      at: '2026-11-02T03:00:00.000Z',
      reason: 'It landed and the deploy was healthy.',
      evidence: 'verify ok; deploy healthy',
      was: { status: 'failed', failureCode: 'release_record_incomplete' },
    };
    await writeRunMetadata(runId, { merge: { repair: earlier }, touch: true });
    await stampReleaseShipped(runId);
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${PLANTED} ON issues`));
    expect((await ownCut(world.token, world.projectId, '0.4.0')).state).toBe('landed');
    const before = await api(world.token, 'GET', `/api/issues/${stuck}`);
    expect(before.body).toMatchObject({
      status: 'awaiting_release',
      shippedIn: { version: '0.4.0' },
    });

    const again = await api(
      world.token,
      'POST',
      `/api/projects/${world.projectId}/releases/0.4.0/repair`,
      {
        outcome: 'shipped',
        reason: 'Settle the roster 0.4.0 shipped.',
        evidence: 'ISS-34 shippedIn 0.4.0',
      },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({
      repeated: true,
      repair: { at: earlier.at },
      roster: { closed: [done, stuck], heldForAgent: [] },
    });
    const after = await api(world.token, 'GET', `/api/issues/${stuck}`);
    expect(after.body).toMatchObject({ status: 'closed', shippedIn: { version: '0.4.0' } });
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

  /** Each generic cancel a person can reach a release run by: refused by name, the run left open. */
  it('refuses the run, session and job cancels of a live release by name, naming its abort', async () => {
    const { runId } = await cut();
    const [job] = (await db.execute(
      sql`SELECT id FROM jobs WHERE pipeline_run_id = ${runId}`,
    )) as unknown as Array<{ id: string }>;
    const device = await createTestDevice(ownerId);
    const [session] = (await db.execute(sql`
      INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
      VALUES (${projectId}, ${device}, ${runId}, 'run_session', 'running', now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    const cancels = [
      ['run', await api(token, 'POST', `/api/pipeline-runs/${runId}/cancel`, {})],
      ['job', await api(token, 'POST', `/api/jobs/${job?.id}/cancel`, {})],
      ['session', await api(token, 'POST', `/api/agent-sessions/${session?.id}/cancel`)],
    ] as const;
    for (const [door, res] of cancels) {
      const [refusal] = refusalsOf(res.body);
      expect(refusal?.code, `${door} cancel: ${JSON.stringify(res.body)}`).toBe(
        'RELEASE_RUN_CANCEL_USE_ABORT',
      );
      expect(refusal?.detail).toContain(
        `/api/projects/${projectId}/release-batches/${runId}/abort`,
      );
      expect(refusal?.detail).toContain('"reason"');
    }
    expect(await runStatus(runId), 'no generic cancel ended the release').toBe('running');
    const [row] = (await db.execute(
      sql`SELECT metadata -> 'failure' AS failure FROM pipeline_runs WHERE id = ${runId}`,
    )) as unknown as Array<{ failure: unknown }>;
    expect(row?.failure, 'a refused cancel records no release_cancelled_without_abort').toBeNull();
  });

  it('aborted by a person keeps that person and the reason they gave, and no failure', async () => {
    const { runId, version } = await cut();
    const reason = 'The deploy target is down for maintenance; re-cut tomorrow.';
    const r = await api(
      token,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/abort`,
      {
        reason,
        pushed: false,
      },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // the roster went back to the gate unpushed, so the page reads the draft that re-cuts it
    const page = await releasePage(token, projectId, version);
    const own = page.cuts.find((c) => c.runId === runId) as Cut;
    expect(own.outcome).toBe('aborted');
    expect(own.abort).toMatchObject({ recorded: true, reason });
    expect(own.decidedBy).toMatchObject({ id: ownerId });
    expect(own.failure).toBeNull();
    expect(await runStatus(runId)).toBe('cancelled');
  });
});
