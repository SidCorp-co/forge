// @direct-test-of packages/core/src/health/project-health.ts
// @direct-test-of packages/core/src/runs/facts-read.ts
/**
 * ISS-1069: the live-run count is one read. The rail, Projects and Activity read `/projects/health`
 * liveRuns; Agents reads `/runs/standing` counts.live. Health counted every running run, a master's
 * pane and an interactive chat included, while the runs read left both out, so one project read 3 on
 * the rail and 1 on Agents. Both now count the runs the runs read lists (`RUN_SCOPE_SQL`).
 */

import { randomUUID } from 'node:crypto';
import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { createTestDevice, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId = '';
let token = '';

async function liveRun(kind: string, session: string | null, deviceId: string): Promise<void> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, created_at, started_at, metadata)
    VALUES (${id}, ${projectId}, ${kind}, 'running', now(), now(), '{}'::jsonb)`);
  if (session === null) return;
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${projectId}, ${deviceId}, ${id}, ${session}, 'running', now(), now())`);
}

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  projectId = (await createTestProject(owner.id)).id;
  token = await userToken(owner.id);
  const deviceId = await createTestDevice(owner.id);
  await liveRun('system', 'run_session', deviceId);
  await liveRun('interactive', null, deviceId);
  await liveRun('system', MASTER_SESSION_KIND, deviceId);
});

describe('one live-run count (ISS-1069)', () => {
  it('health counts the runs the runs read lists, neither a master pane nor a chat', async () => {
    const health = await api(token, 'GET', '/api/projects/health');
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    const rows = (health.body.projects ?? health.body) as Array<{ id: string; liveRuns: number }>;
    const mine = rows.find((p) => p.id === projectId);
    const standing = await api(token, 'GET', `/api/projects/${projectId}/runs/standing`);
    expect(standing.status, JSON.stringify(standing.body)).toBe(200);
    const live = (standing.body.counts as { live: number }).live;
    expect(live).toBe(1);
    expect(mine?.liveRuns, 'health counted a master pane or a chat as a live run').toBe(live);
  });
});
