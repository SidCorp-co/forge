import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from './api.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
} from './factories.js';

// The rows a forecast reads, seeded where they live: issues, their status moves in activity_log,
// the release runs that shipped them, and a runner able to take the work.

export const MINUTE = 60_000;
export const DAY = 86_400_000;

export interface World {
  projectId: string;
  userId: string;
  token: string;
  runnerId: string;
  deviceId: string;
  seq: number;
  reqSeq: number;
  fbSeq: number;
  versions: number;
}

export async function world(): Promise<World> {
  const user = await createTestUser({ verified: true });
  const project = await createTestProject(user.id);
  await addProjectMember(project.id, user.id, 'admin');
  const device = await createTestDevice(user.id);
  const runnerId = randomUUID();
  await db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, repo_path)
    VALUES (${runnerId}, ${project.id}, 'claude-code', ${device}, 'box', 'online', now(), '/srv/checkout')
  `);
  return {
    projectId: project.id,
    userId: user.id,
    token: await userToken(user.id),
    runnerId,
    deviceId: device,
    seq: 0,
    reqSeq: 0,
    fbSeq: 0,
    versions: 0,
  };
}

export async function issue(
  w: World,
  over: {
    status: string;
    createdAt: Date;
    mergedAt?: Date | null;
    waitingKind?: string;
    priority?: string;
    requirementId?: string | null;
  },
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  w.seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, merged_at, waiting_kind, priority, requirement_id)
    VALUES (${id}, ${w.projectId}, ${w.seq}, ${`issue ${w.seq}`}, ${over.status}, ${w.userId},
            ${over.createdAt.toISOString()}, ${over.mergedAt?.toISOString() ?? null},
            ${over.waitingKind ?? null}, ${over.priority ?? 'medium'}, ${over.requirementId ?? null})
  `);
  return { id, key: `ISS-${w.seq}` };
}

export async function moved(
  w: World,
  issueId: string,
  from: string,
  to: string,
  at: Date,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
    VALUES (${issueId}, 'user', ${w.userId}, 'human', 'issue.statusChanged',
            ${JSON.stringify({ from, to })}::jsonb, ${at.toISOString()})
  `);
}

/** `n` issues landed one a day, each `45..75` minutes from in_progress to merge (p50 59). */
export interface Landed {
  id: string;
  minutes: number;
  mergedAt: Date;
}

export async function landHistory(w: World, n: number): Promise<Landed[]> {
  const out: Landed[] = [];
  for (let i = 0; i < n; i++) {
    const took = 45 + Math.round((30 * i) / Math.max(1, n - 1));
    const merged = new Date(Date.now() - (n - i) * DAY);
    const started = new Date(merged.getTime() - took * MINUTE);
    const { id } = await issue(w, {
      status: 'closed',
      createdAt: new Date(started.getTime() - MINUTE),
      mergedAt: merged,
    });
    await moved(w, id, 'open', 'in_progress', started);
    out.push({ id, minutes: took, mergedAt: merged });
  }
  return out;
}

/** A run a box declared: its run session started at `start`, its run finished at `end` (null: still open). */
export async function declaredRun(w: World, start: Date, end: Date | null): Promise<void> {
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, metadata)
    VALUES (${runId}, ${w.projectId}, 'system', ${end ? 'completed' : 'running'}, ${start.toISOString()},
            ${end?.toISOString() ?? null}, '{}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${w.projectId}, ${w.deviceId}, ${runId}, 'run_session', ${end ? 'completed' : 'running'},
            ${start.toISOString()}, ${start.toISOString()})
  `);
}

/** A release run that shipped `issueIds` at `at`, under the next patch number. */
export async function shipRelease(
  w: World,
  issueIds: readonly string[],
  at: Date,
): Promise<string> {
  w.versions += 1;
  const version = `0.0.${w.versions}`;
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (${randomUUID()}, ${w.projectId}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()},
            ${version}, ${at.toISOString()}, ${JSON.stringify({ issueIds })}::jsonb)
  `);
  return version;
}

export async function requirement(w: World, title: string): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  w.reqSeq += 1;
  await db.execute(sql`
    INSERT INTO requirements (id, project_id, req_seq, title, status)
    VALUES (${id}, ${w.projectId}, ${w.reqSeq}, ${title}, 'draft')
  `);
  return { id, key: `REQ-${w.reqSeq}` };
}

/** A feedback item, untriaged, or triaged onto `carriers` as an issue route. */
export async function feedback(w: World, carriers: readonly string[] = []): Promise<string> {
  w.fbSeq += 1;
  const seq = w.fbSeq;
  await db.transaction(async (tx) => {
    const [made] = (await tx.execute(sql`
      INSERT INTO feedback (project_id, fb_seq, kind, title, where_seen, status, route, reported_by, reporter_agency)
      VALUES (${w.projectId}, ${seq}, 'bug', ${`feedback ${seq}`}, 'The board',
              ${carriers.length ? 'triaged' : 'new'}, ${carriers.length ? 'issue' : null}, ${w.userId}, 'human')
      RETURNING id
    `)) as unknown as { id: string }[];
    for (const issueId of carriers) {
      await tx.execute(sql`
        INSERT INTO feedback_route_issues (feedback_id, issue_id) VALUES (${made?.id}, ${issueId})
      `);
    }
  });
  return `FB-${seq}`;
}

export const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

export async function read(w: World, path: string): Promise<Body> {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/forecast${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
