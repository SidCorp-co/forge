/**
 * ISS-1320 — the sessions `pipelineHealth` counts for an issue, against real Postgres.
 *
 * Its own file: `pipeline-health-lanes-e2e.test.ts` seeds a run session by its lease row alone,
 * and the subject here is the run's recorded group, which outlives that row. A describe over the
 * size budget's function limit is the other reason it is not a section of that file.
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

describe('ISS-1320 the sessions opened over an issue', () => {
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
   *  session whose metadata names no issue, and the `issue_leases` row that is the run's hold.
   *  `finished` gives every issue back and ends the session, which deletes those rows and leaves
   *  the recorded group; `group` picks which record carries it (ISS-1320). */
  async function openRunSessionRow(
    projectId: string,
    issueKeys: string[],
    opts: {
      status?: string;
      finished?: boolean;
      group?: 'runGroup' | 'runIssueStatuses' | 'none';
    } = {},
  ): Promise<string> {
    const runId = randomUUID();
    const sessionId = randomUUID();
    const owner = (await harness.db.execute(
      sql`SELECT created_by AS id FROM projects WHERE id = ${projectId}`,
    )) as unknown as Array<{ id: string }>;
    const device = await createTestDevice(harness.db, owner[0]?.id as string);
    const group = opts.group ?? 'runGroup';
    const metadata: Record<string, unknown> = {
      type: 'run_session',
      runIssues: opts.finished ? [] : issueKeys,
      ...(group === 'runGroup' ? { runGroup: issueKeys } : {}),
      ...(group === 'runIssueStatuses'
        ? { runIssueStatuses: Object.fromEntries(issueKeys.map((k) => [k, 'in_progress'])) }
        : {}),
    };
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running', ${JSON.stringify(metadata)}::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status,
                                  title, metadata, started_at, last_heartbeat_at)
      VALUES (${sessionId}, ${projectId}, ${device.id}, ${runId}, 'run_session',
              ${opts.status ?? 'running'}, 'run: box-1',
              ${JSON.stringify({ terminalName: 'box-1', deviceId: device.id })}::jsonb,
              now(), now())
    `);
    if (opts.finished) return sessionId;
    for (const key of issueKeys) {
      await harness.db.execute(sql`
        INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
        VALUES (${projectId}, ${key}, ${device.id}, ${sessionId}, ${runId})
      `);
    }
    return sessionId;
  }

  // ISS-1320 — ISS-1314 served `none of the 1 agent session ... (completed)` over six sessions:
  // the run-session bind was the surviving lease row, and a finished run leaves none. Planted
  // before the fix: ISS-1314's shape, one completed session whose lease row survived beside three
  // that gave the issue back, plus a session over a different issue that must not be counted.
  it('counts every run session opened over the issue, not only the one whose lease row survived', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, 132001);
    await insertIssue(project.id, 132002);
    await openRunSessionRow(project.id, ['ISS-132001'], { status: 'completed', finished: true });
    await openRunSessionRow(project.id, ['ISS-132001', 'ISS-132002'], {
      status: 'completed',
      finished: true,
    });
    await openRunSessionRow(project.id, ['ISS-132001'], {
      status: 'cancelled_stale',
      finished: true,
    });
    await openRunSessionRow(project.id, ['ISS-132002'], { status: 'completed', finished: true });
    await openRunSessionRow(project.id, ['ISS-132001'], { status: 'completed' });
    const leases = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM issue_leases WHERE issue_key = 'ISS-132001'`,
    )) as unknown as Array<{ n: number }>;
    expect(leases[0]?.n).toBe(1);

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    const detail = (health.worker as { detail: string }).detail;
    expect(health.worker.lane).toBe('none');
    expect(detail).toContain('none of the 4 agent sessions on record as opened over this issue');
    expect(detail).toContain('(cancelled_stale, completed)');
  });

  it('counts a finished run session whose run only carries runIssueStatuses', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, 132003);
    await openRunSessionRow(project.id, ['ISS-132003'], {
      status: 'failed',
      finished: true,
      group: 'runIssueStatuses',
    });
    await openRunSessionRow(project.id, ['ISS-132003'], {
      status: 'completed',
      finished: true,
      group: 'none',
    });

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    const detail = (health.worker as { detail: string }).detail;
    expect(detail).toContain('none of the 1 agent session on record as opened over this issue');
    expect(detail).toContain('(failed)');
  });

  it('does not read a running run session that has given the issue back as its worker', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, 132004);
    await openRunSessionRow(project.id, ['ISS-132004'], { finished: true, status: 'running' });

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    expect(health.worker.lane).toBe('none');
    expect(health.activeSession).toBeUndefined();
    expect((health.worker as { detail: string }).detail).toContain('(running)');
  });

  it('keeps the holder of the lease as the worker beside a session that gave the issue back', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, 132005);
    await openRunSessionRow(project.id, ['ISS-132005'], { finished: true, status: 'completed' });
    const holder = await openRunSessionRow(project.id, ['ISS-132005']);

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    expect(health.worker).toMatchObject({ lane: 'run_session', sessionId: holder });
  });

  it('does not count a session whose group named the same key in another project', async () => {
    const { project } = await seedProject();
    const other = await seedProject();
    const issueId = await insertIssue(project.id, 132006);
    await openRunSessionRow(other.project.id, ['ISS-132006'], {
      status: 'completed',
      finished: true,
    });

    const health = healthOf(
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]),
      issueId,
    );
    expect((health.worker as { detail: string }).detail).toContain(
      'no agent session is on record as opened over this issue',
    );
  });
});
