/**
 * The forge-dev side of a beta port test (ISS-923): a `beta_port` schedule made, its secrets put and
 * fired through the routes a person uses, and each fire read back once it settles. Shared by
 * the beta port e2e tests; forge-beta is `beta-port-world.ts`. A twin is seeded as a port made it
 * before ISS-982, which files a beta issue as Feedback and makes no twin.
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

export interface DevFeedbackRow {
  id: string;
  fb_seq: number;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  where_seen: string | null;
  status: string;
  reported_by: string;
  reporter_agency: string;
  dedup_key: string | null;
}

/** Every Feedback item of a dev project, oldest first. */
export const devFeedbackOf = (projectId: string) =>
  rows<DevFeedbackRow>(
    sql`SELECT id, fb_seq, kind, severity, title, body, where_seen, status, reported_by, reporter_agency, dedup_key FROM feedback WHERE project_id = ${projectId} ORDER BY fb_seq`,
  );

/**
 * An issue twin as a port made it before ISS-982: a dev issue at `status` in `project`, and its pair
 * recording that status as mirrored and the beta status beta stood at. Its id and key.
 */
export async function seedTwin(
  say: Say,
  project: { id: string; slug: string },
  source: { id: string; displayId: string; title: string; status: string },
  status = 'open',
): Promise<{ id: string; key: string }> {
  const created = ok(
    await say('owner', 'POST', `/api/projects/${project.id}/issues`, {
      title: source.title,
      description: `Ported from forge-beta ${source.displayId} (${source.id}).`,
      status: 'draft',
    }),
    201,
  );
  const id = created.id as string;
  await setDevStatus(id, status);
  await rows(
    sql`INSERT INTO beta_port_pairs (beta_issue_id, beta_key, beta_project_slug, dev_issue_id, last_mirrored_status, last_tried_status, beta_reached)
        VALUES (${source.id}, ${source.displayId}, ${project.slug}, ${id}, ${status}, ${status}, ${source.status})`,
  );
  const [dev] = await rows<{ iss_seq: number }>(sql`SELECT iss_seq FROM issues WHERE id = ${id}`);
  return { id, key: `ISS-${dev?.iss_seq}` };
}

/**
 * A dev issue moved to `status` the way the kernel writes it, as a test's stand-in for its flow; a
 * park at `needs_info` names what it waits on, as the kernel's does.
 */
export async function setDevStatus(issueId: string, status: string): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  const waiting = status === 'needs_info' ? 'needs_answer' : null;
  await withKernelMarker(db, (tx) =>
    tx.execute(
      sql`UPDATE issues SET status = ${status}, waiting_kind = ${waiting} WHERE id = ${issueId}`,
    ),
  );
}
