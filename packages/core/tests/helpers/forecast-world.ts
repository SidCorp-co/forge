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
