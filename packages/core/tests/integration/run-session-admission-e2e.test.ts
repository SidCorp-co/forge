/**
 * ISS-1110 — a box that may not serve a project, opening a run session there.
 *
 * Opening a run session is the write by which a box takes issues. Before this, it refused one
 * predicate by name (the lease, ISS-1109) and asked nothing about the box itself, so a device with
 * no runner on the project, a disabled device and a withdrawn runner each opened a run and took
 * leases on that project's issues. The pool's `prepare` already refused all three by name; the
 * open now asks the same predicate, and a refused open writes nothing.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
let RunnerNotAdmittedError: typeof import('../../src/devices/pool-admission.js').RunnerNotAdmittedError;
let ADMITTED_BOX: string;
let prepareJobForMaster: typeof import('../../src/devices/claim.js').prepareJobForMaster;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  ({ openRunSession } = await import('../../src/devices/run-session.js'));
  ({ RunnerNotAdmittedError, ADMITTED_BOX } = await import('../../src/devices/pool-admission.js'));
  ({ prepareJobForMaster } = await import('../../src/devices/claim.js'));
  await registerIntegrationsForTest();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

type Planted =
  | 'admitted'
  | 'offline'
  | 'runner_unbound'
  | 'device_disabled'
  | 'runner_withdrawn'
  | 'draining';

/** One project with one issue, and one box planted in the state named. */
async function boxThat(state: Planted) {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const box = await createTestDevice(harness.db, user.id);
  if (state !== 'runner_unbound') {
    const status =
      state === 'runner_withdrawn'
        ? 'disabled'
        : state === 'draining'
          ? 'draining'
          : state === 'offline'
            ? 'offline'
            : 'online';
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (gen_random_uuid(), ${project.id}, ${box.id}, 'r1', 'claude-code', ${status})
    `);
  }
  if (state === 'device_disabled') {
    await harness.db.execute(sql`UPDATE devices SET disabled_at = now() WHERE id = ${box.id}`);
  }
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (gen_random_uuid(), ${project.id}, 880, 'issue 880', 'open', ${user.id})
  `);
  return { user, project, box };
}

async function counts(): Promise<{ sessions: number; runs: number; leases: number }> {
  const rows = (await harness.db.execute(sql`
    SELECT (SELECT count(*)::int FROM agent_sessions) AS sessions,
           (SELECT count(*)::int FROM pipeline_runs) AS runs,
           (SELECT count(*)::int FROM issue_leases) AS leases
  `)) as unknown as Array<{ sessions: number; runs: number; leases: number }>;
  const row = rows[0];
  return {
    sessions: Number(row?.sessions ?? 0),
    runs: Number(row?.runs ?? 0),
    leases: Number(row?.leases ?? 0),
  };
}

async function refusalOf(call: Promise<unknown>): Promise<Error | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return err as Error;
  }
}

function open(projectId: string, deviceId: string) {
  return openRunSession({ deviceId, projectId, issueKeys: ['ISS-880'], name: 'run-a' });
}

describe('a box that may not serve the project is refused on the open, by name', () => {
  for (const [state, reason] of [
    ['runner_unbound', 'runner_unbound'],
    ['device_disabled', 'device_disabled'],
    ['runner_withdrawn', 'runner_withdrawn'],
    ['draining', 'runner_withdrawn'],
  ] as const) {
    it(`${state} is refused as ${reason}`, async () => {
      const { project, box } = await boxThat(state);

      const refusal = await refusalOf(open(project.id, box.id));

      expect(
        refusal,
        `a ${state} box opened a run session and took the lease on ISS-880: the open asked nothing about the box`,
      ).toBeInstanceOf(RunnerNotAdmittedError);
      expect((refusal as InstanceType<typeof RunnerNotAdmittedError>).reason).toBe(reason);
      expect(refusal?.message, 'the refusal names the predicate').toContain(reason);
      expect(refusal?.message, 'the refusal names the project it was asked about').toContain(
        project.id,
      );
      expect(refusal?.message, 'the refusal names the box it refused').toContain(box.id);
      expect(refusal?.message, 'a box told no is told what yes looks like').toContain(
        'An admitted box has a runner on this project whose status is online or offline, on a device that is not disabled.',
      );
      expect(ADMITTED_BOX).toBe(
        'An admitted box has a runner on this project whose status is online or offline, on a device that is not disabled.',
      );
    });

    it(`${state} leaves no run, no session and no lease behind`, async () => {
      const { project, box } = await boxThat(state);

      await refusalOf(open(project.id, box.id));

      expect(await counts()).toEqual({ sessions: 0, runs: 0, leases: 0 });
    });
  }

  for (const state of ['admitted', 'offline'] as const) {
    it(`a box whose runner is ${state === 'admitted' ? 'online' : 'offline'} still opens`, async () => {
      const { project, box } = await boxThat(state);

      const opened = await open(project.id, box.id);

      expect(opened.sessionId).toBeTruthy();
      expect(await counts()).toMatchObject({ sessions: 1, runs: 1 });
    });
  }

  it('an admitted open holds the lease on the issue it names', async () => {
    const { project, box } = await boxThat('admitted');

    const opened = await open(project.id, box.id);

    const rows = (await harness.db.execute(sql`
      SELECT issue_key, session_id FROM issue_leases WHERE project_id = ${project.id}
    `)) as unknown as Array<{ issue_key: string; session_id: string }>;
    expect(rows).toEqual([{ issue_key: 'ISS-880', session_id: opened.sessionId }]);
  });

  it('a retried open of a committed box run answers with its session after the runner was withdrawn', async () => {
    const { project, box } = await boxThat('admitted');
    const declaration = {
      deviceId: box.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
      boxRunId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    const first = await openRunSession(declaration);
    await harness.db.execute(sql`
      UPDATE runners SET status = 'draining' WHERE project_id = ${project.id} AND device_id = ${box.id}
    `);

    const retried = await openRunSession(declaration);

    expect(
      retried,
      'a box whose reply was lost, refused on the retry, leaves a live session holding the lease until the reaper',
    ).toEqual(first);
    expect(await counts()).toEqual({ sessions: 1, runs: 1, leases: 1 });
  });

  it('a box bound to a different project is unbound on this one', async () => {
    const { project: other, box } = await boxThat('admitted');
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);

    const refusal = await refusalOf(open(project.id, box.id));

    expect((refusal as InstanceType<typeof RunnerNotAdmittedError> | null)?.reason).toBe(
      'runner_unbound',
    );
    expect(other.id).not.toBe(project.id);
  });
});

describe('the pool and the run-session open ask one predicate', () => {
  const THREE = ['runner_unbound', 'device_disabled', 'runner_withdrawn'] as const;

  /** What `prepare` answered about admission, normalised: its other refusals are not admission. */
  function prepared(result: Awaited<ReturnType<typeof prepareJobForMaster>>) {
    if (!result.ok && (THREE as readonly string[]).includes(result.reason)) {
      return { admitted: false, reason: result.reason };
    }
    return { admitted: true, reason: null };
  }

  async function opened(projectId: string, deviceId: string) {
    const refusal = await refusalOf(open(projectId, deviceId));
    if (refusal instanceof RunnerNotAdmittedError)
      return { admitted: false, reason: refusal.reason };
    if (refusal) throw refusal;
    return { admitted: true, reason: null };
  }

  for (const state of [
    'runner_unbound',
    'device_disabled',
    'runner_withdrawn',
    'draining',
    'admitted',
    'offline',
  ] as const) {
    it(`agree on a box planted ${state}`, async () => {
      const { user, project, box } = await boxThat(state);
      const run = randomUUID();
      const job = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status)
        VALUES (${run}, ${project.id}, 'system', 'running')
      `);
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, queued_at, payload)
        VALUES (${job}, ${project.id}, ${run}, 'reconcile', 'queued', ${user.id}, now(),
                '{"promptString":"do the step"}'::jsonb)
      `);

      const fromPool = prepared(
        await prepareJobForMaster({ jobId: job, deviceId: box.id, sessionId: randomUUID() }),
      );
      const fromOpen = await opened(project.id, box.id);

      expect(fromOpen).toEqual(fromPool);
    });
  }
});
