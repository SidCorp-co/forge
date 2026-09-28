/**
 * ISS-1273 — `pipelineHealth` across the three lanes that open work, against real Postgres.
 *
 * Its own file rather than a section of `pipeline-health-e2e.test.ts`: the subject is the two
 * binds and the claim read, each of which needs rows that file's fixtures do not write, and that
 * file's one describe is at its frozen size budget.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type PipelineHealthModule = typeof import('../../src/issues/pipeline-health.js');
type Health = Awaited<ReturnType<PipelineHealthModule['hydratePipelineHealthForIssues']>>;

/** Refuses by name a row the hydrator answered for nobody, rather than asserting it away. */
function healthOf(map: Health, issueId: string) {
  const health = map.get(issueId);
  if (health === undefined) throw new Error(`pipelineHealth answered for no issue ${issueId}`);
  return health;
}

describe('ISS-1273 pipelineHealth across the three worker lanes', () => {
  let harness: TestDatabase;
  let mods: {
    hydratePipelineHealthForIssues: PipelineHealthModule['hydratePipelineHealthForIssues'];
  };

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    mods = (await import('../../src/issues/pipeline-health.js')) as unknown as typeof mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedProject() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    return { owner, project };
  }

  async function insertIssue(projectId: string, issSeq: number): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${id}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, 'in_progress', 'medium',
              (SELECT created_by FROM projects WHERE id = ${projectId}))
    `);
    return id;
  }

  /** A run session as `devices/run-session.ts` opens one: a group run with `issue_id` null, a
   *  session whose metadata names no issue, and the `issue_leases` row that is the only link. */
  async function openRunSessionRow(projectId: string, issueKeys: string[]): Promise<string> {
    const runId = randomUUID();
    const sessionId = randomUUID();
    const owner = (await harness.db.execute(
      sql`SELECT created_by AS id FROM projects WHERE id = ${projectId}`,
    )) as unknown as Array<{ id: string }>;
    const device = await createTestDevice(harness.db, owner[0]?.id as string);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running',
              ${JSON.stringify({ type: 'run_session', runIssues: issueKeys })}::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status,
                                  title, metadata, started_at, last_heartbeat_at)
      VALUES (${sessionId}, ${projectId}, ${device.id}, ${runId}, 'run_session', 'running',
              'run: box-1', ${JSON.stringify({ terminalName: 'box-1', deviceId: device.id })}::jsonb,
              now(), now())
    `);
    for (const key of issueKeys) {
      await harness.db.execute(sql`
        INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
        VALUES (${projectId}, ${key}, ${device.id}, ${sessionId}, ${runId})
      `);
    }
    return sessionId;
  }

  async function stampClaim(issueId: string, holder: string, ageHours: number): Promise<void> {
    await harness.db.execute(sql`
      UPDATE issues
         SET session_context = jsonb_build_object('lease', jsonb_build_object(
               'holder', ${holder}::text,
               'renewedAt', to_jsonb(now() - make_interval(hours => ${ageHours}::int)),
               'minutes', 60))
       WHERE id = ${issueId}
    `);
  }

  // The planted failure: `openRunSession` writes `{ terminalName, deviceId }` as the session's
  // metadata, so the job lane's `metadata->>'issueId'` bind matches nothing here. The lease is the
  // only link, and this is the case that proves the second bind carries it.
  it('binds a run session to EVERY issue of its group through the lease, not through metadata', async () => {
    const { project } = await seedProject();
    const first = await insertIssue(project.id, 127301);
    const second = await insertIssue(project.id, 127302);
    const sessionId = await openRunSessionRow(project.id, ['ISS-127301', 'ISS-127302']);

    const stamped = (await harness.db.execute(
      sql`SELECT metadata FROM agent_sessions WHERE id = ${sessionId}`,
    )) as unknown as Array<{ metadata: Record<string, unknown> }>;
    expect(stamped[0]?.metadata.issueId).toBeUndefined();

    const map = await mods.hydratePipelineHealthForIssues(project.id, [first, second]);
    for (const issueId of [first, second]) {
      const health = healthOf(map, issueId);
      expect(health.activeSession).toMatchObject({ id: sessionId, status: 'running' });
      expect(health.worker).toMatchObject({ lane: 'run_session', sessionId });
    }
  });

  it('names the claim lane and its holder where no session row exists at all', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, 127303);
    await stampClaim(issueId, 'iss-1273-52b95148', 0);

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    expect(health.activeSession).toBeUndefined();
    expect(health.worker).toMatchObject({ lane: 'claim', holder: 'iss-1273-52b95148' });
  });

  it('reads an expired claim as no lane holding the row, naming the verdict', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, 127304);
    await stampClaim(issueId, 'iss-0000-deadbeef', 5);

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    const worker = health.worker as { lane: string; detail: string };
    expect(worker.lane).toBe('none');
    expect(worker.detail).toContain('expired');
  });

  // `{ stage }` alone is the status column the caller already had, so a row nothing holds carries
  // the absence as a sentence instead: an empty field is not a quiet system.
  it('never answers with stage as its only key, and says why no lane holds the row', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, 127305);

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    expect(Object.keys(health).sort()).not.toEqual(['stage']);
    expect(health.worker.lane).toBe('none');
    expect((health.worker as { detail: string }).detail).toContain('carries no claim');
  });

  it('does not bind a run session to an issue whose lease belongs to another project', async () => {
    const { project } = await seedProject();
    const other = await seedProject();
    const issueId = await insertIssue(project.id, 127306);
    await openRunSessionRow(other.project.id, ['ISS-127306']);

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    expect(health.worker.lane).toBe('none');
  });
});
