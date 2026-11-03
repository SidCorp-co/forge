/**
 * The forge-dev side of a beta port test (ISS-923): a `beta_port` schedule made, its secrets put and
 * fired through the routes a person uses, and each fire read back once it settles. Shared by
 * `beta-port-e2e.test.ts` and `beta-port-backfill-e2e.test.ts`; forge-beta is `beta-port-world.ts`.
 */

import { sql } from 'drizzle-orm';
import { type FireRow, settledFire } from './beta-port-world.js';
import { ok, type Reply } from './ecosystem-world.js';
import { rows } from './factories.js';

export type Say = (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;

/** A `beta_port` schedule on `projectId`, made by the owner; its id. */
export async function betaPortScheduleOn(say: Say, projectId: string): Promise<string> {
  const created = ok(
    await say('owner', 'POST', '/api/schedules', {
      projectId,
      name: 'Beta port',
      cron: '*/15 * * * *',
      kind: 'beta_port',
    }),
    201,
  );
  return created.id as string;
}

/** One of the beta port's secrets put on `projectId`. */
export async function putBetaSecret(say: Say, projectId: string, name: string, value: string) {
  ok(
    await say('owner', 'PUT', `/api/projects/${projectId}/secrets/integration/${name}`, { value }),
  );
}

/** One press of `/run`, and the fire it made once settled (or the fire a refused press recorded). */
export async function fireOnce(say: Say, scheduleId: string) {
  const run = await say('owner', 'POST', `/api/schedules/${scheduleId}/run`);
  if (run.status === 202) {
    const fireId = (run.json as { fireId: string }).fireId;
    return { http: run.status, body: run.json, ...(await settledFire(fireId)) };
  }
  const [settled] = await rows<FireRow>(
    sql`SELECT id, status, reason, refusal, output, error FROM schedule_runs WHERE schedule_id = ${scheduleId} ORDER BY started_at DESC LIMIT 1`,
  );
  if (!settled) throw new Error('the run pressed recorded no fire');
  return { http: run.status, body: run.json, ...settled };
}

export interface DevIssueRow {
  id: string;
  iss_seq: number;
  status: string;
  description: string | null;
  title: string;
  priority: string;
  category: string | null;
  created_via: string;
  created_by_id: string;
  schedule_run_id: string | null;
}

/** Every issue of a dev project, oldest first. */
export const devIssuesOf = (projectId: string) =>
  rows<DevIssueRow>(
    sql`SELECT id, iss_seq, status, description, title, priority, category, created_via, created_by_id, schedule_run_id FROM issues WHERE project_id = ${projectId} ORDER BY iss_seq`,
  );
