import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from './api.js';
import {
  addProjectMember,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRelease,
  createTestRequirement,
  createTestRunSession,
  createTestUser,
  recordStatusMove,
  type TestIssueInput,
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

/**
 * A live master session serving the project. A wait on the master with nobody serving reads stuck
 * (`nobody_serves`), and a stuck item never forecasts a landing (REQ-48 BC-8), so a world that
 * forecasts work a master takes seats one.
 */
export async function servingMaster(w: World): Promise<void> {
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${w.projectId}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, device_id, last_heartbeat_at)
    VALUES (${randomUUID()}, ${w.projectId}, ${w.userId}, ${runId}, 'master', 'running', ${w.deviceId}, now())
  `);
}

/**
 * A run session a box opened over `issueKeys`, holding a lease on each as the take door writes it:
 * an issue at in_progress that nothing holds reads stuck (no holder), and never forecasts.
 */
export async function workingRun(w: World, issueKeys: readonly string[]): Promise<void> {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const metadata = JSON.stringify({ type: 'run_session', runGroup: issueKeys });
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${w.projectId}, 'system', 'running', now(), ${metadata}::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, started_at, created_at, last_heartbeat_at)
    VALUES (${sessionId}, ${w.projectId}, ${w.deviceId}, ${runId}, 'run_session', 'running', now(), now(), now())
  `);
  for (const key of issueKeys) {
    await db.execute(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      VALUES (${w.projectId}, ${key}, ${w.deviceId}, ${sessionId}, ${runId})
    `);
  }
}

export function issue(w: World, over: TestIssueInput): Promise<{ id: string; key: string }> {
  w.seq += 1;
  return createTestIssue(w.projectId, w.userId, w.seq, over);
}

export function moved(
  w: World,
  issueId: string,
  from: string,
  to: string,
  at: Date,
): Promise<void> {
  return recordStatusMove(issueId, w.userId, from, to, at);
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
  await createTestRunSession(w.projectId, w.deviceId, start, end);
}

/** A release run that shipped `issueIds` at `at`, under the next patch number. */
export async function shipRelease(
  w: World,
  issueIds: readonly string[],
  at: Date,
): Promise<string> {
  w.versions += 1;
  const version = `0.0.${w.versions}`;
  await createTestRelease(w.projectId, version, issueIds, at);
  return version;
}

export function requirement(w: World, title: string): Promise<{ id: string; key: string }> {
  w.reqSeq += 1;
  return createTestRequirement(w.projectId, w.reqSeq, title);
}

/** A draft requirement the world's user owns: one with no owner reads stuck (`no_owner`), and never forecasts. */
export async function ownedRequirement(
  w: World,
  title: string,
): Promise<{ id: string; key: string }> {
  const made = await requirement(w, title);
  await db.execute(sql`UPDATE requirements SET owner_id = ${w.userId} WHERE id = ${made.id}`);
  return made;
}

/** A feedback item, untriaged, or triaged onto `carriers` as an issue route. */
export function feedback(w: World, carriers: readonly string[] = []): Promise<string> {
  w.fbSeq += 1;
  return createTestFeedback(w.projectId, w.userId, w.fbSeq, carriers);
}

export const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

export async function read(w: World, path: string): Promise<Body> {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/forecast${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
