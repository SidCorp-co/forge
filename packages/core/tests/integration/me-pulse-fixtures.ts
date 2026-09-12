/**
 * ISS-988 — the shared harness and seed helpers for the `/api/me/pulse` suites.
 *
 * Split out of the spec because the endpoint's figures divide into two groups
 * that seed the same five tables differently, and one describe holding both
 * outgrew the 150-line function budget.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { expect } from 'vitest';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

export interface PulseHarness {
  harness: TestDatabase;
  app: Hono<{ Variables: RequestIdVars }>;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
}

export async function setupPulseHarness(): Promise<PulseHarness> {
  const harness = await setupTestDatabase();
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

  const { mePulseRoutes } = await import('../../src/me/pulse-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  const signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/me', mePulseRoutes);
  app.onError(errorHandler);

  return { harness, app, signUserToken };
}

export function pulseSeeders(h: PulseHarness) {
  let seq = 100;

  const member = async () => {
    const user = await createTestUser(h.harness.db);
    await h.harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`,
    );
    const project = await createTestProject(h.harness.db, user.id);
    return { user, project, token: await h.signUserToken(user.id) };
  };

  const pulse = async (token: string, query = ''): Promise<PulseResponse> => {
    const res = await h.app.request(`/api/me/pulse${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as PulseResponse;
  };

  const addIssue = async (args: {
    projectId: string;
    userId: string;
    status?: string;
    seq?: number;
    updatedAgo?: string;
    mergedAt?: boolean;
    reopenCount?: number;
  }) => {
    const id = randomUUID();
    await h.harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, updated_at, merged_at, reopen_count)
      VALUES (${id}, ${args.projectId}, ${args.seq ?? 1}, 'seeded', ${args.status ?? 'open'}, ${args.userId},
              now() - ${args.updatedAgo ?? '1 minute'}::interval,
              ${args.mergedAt ? sql`now()` : sql`NULL`}, ${args.reopenCount ?? 0})
    `);
    return id;
  };

  // cm:guard `pipeline_runs_issue_kind_chk` refuses an `issue`-kind run with no issue, so one is seeded here rather than the kind being quietly relaxed to 'system' — which would move the row into the scheduler lane and quietly weaken every liveness case built on it.
  const openRun = async (
    projectId: string,
    kind = 'issue',
    issueId: string | null = null,
    userId?: string,
  ) => {
    const id = randomUUID();
    let linked = issueId;
    if (kind === 'issue' && linked === null && userId) {
      linked = await addIssue({ projectId, userId, status: 'in_progress', seq: seq++ });
    }
    await h.harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, ${linked}, ${kind}, 'running', now())
    `);
    return id;
  };

  const addJob = async (args: {
    projectId: string;
    runId: string;
    userId: string;
    status: string;
    type?: string;
    issueId?: string | null;
    queuedAgo?: string;
  }) => {
    const id = randomUUID();
    await h.harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, type, status, created_by, queued_at)
      VALUES (${id}, ${args.projectId}, ${args.runId}, ${args.issueId ?? null}, ${args.type ?? 'code'},
              ${args.status}, ${args.userId}, now() - ${args.queuedAgo ?? '1 minute'}::interval)
    `);
    return id;
  };

  /**
   * An `issue.statusChanged` row, optionally stamped at the issue's own
   * `merged_at` the way a real close writes the pair.
   */
  // cm:guard `stampedAtMergedAt` writes created_at = issues.merged_at in ONE statement because that timestamp identity IS how the shipped-evidence predicate spots the auto-stamp — seeding the two separately gives them different microseconds and the case silently stops testing anything (ISS-817).
  const addTransition = async (args: {
    issueId: string;
    userId: string;
    to: string;
    stampedAtMergedAt?: boolean;
  }) => {
    await h.harness.db.execute(sql`
      INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
      VALUES (${randomUUID()}, ${args.issueId}, 'user', ${args.userId}, 'issue.statusChanged',
              ${JSON.stringify({ to: args.to })}::jsonb,
              ${args.stampedAtMergedAt ? sql`(SELECT merged_at FROM issues WHERE id = ${args.issueId})` : sql`now()`})
    `);
  };

  const nextSeq = () => seq++;

  return { member, pulse, addIssue, openRun, addJob, addTransition, nextSeq };
}
