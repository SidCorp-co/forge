/**
 * ISS-927 — a session token lives exactly as long as its session.
 *
 * The sibling of `job-token-lifecycle.test.ts`, and it carries one case that
 * file does not need: the session axis has TWO terminal writers, not one. The
 * kernel chokepoint (`applyKernelTransition`) covers cancel, the sweeper and a
 * dispatch failure, but the runner's happy-path completion is a direct
 * `db.update` in `PATCH /api/agent-sessions/:id` that the chokepoint never
 * sees — and the `lifecycle.transition` guard test cannot detect it either,
 * because it scans for a status LITERAL and that handler writes a variable.
 *
 * A revoke wired into the chokepoint alone therefore passes every case here
 * except the commonest one in production, silently. That is the case this file
 * exists for; the others are here so it cannot be the only one that holds.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mintSessionToken: typeof import('../../src/agent-sessions/session-token.js').mintSessionToken;
let revokeSessionToken: typeof import('../../src/agent-sessions/session-token.js').revokeSessionToken;
let applyKernelTransition: typeof import('../../src/lifecycle/transition.js').applyKernelTransition;
let verifyPat: typeof import('../../src/auth/pat.js').verifyPat;
let countActivePatsForUser: typeof import('../../src/auth/pat.js').countActivePatsForUser;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let authenticatePat: typeof import('../../src/middleware/require-pat.js').authenticatePat;
let principalActor: typeof import('../../src/mcp/tools/lib.js').principalActor;
let dbMod: typeof import('../../src/db/client.js');
let schema: typeof import('../../src/db/schema.js');
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let app: Hono;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [tok, trans, pat, client, sch, mw, mcpLib] = await Promise.all([
    import('../../src/agent-sessions/session-token.js'),
    import('../../src/lifecycle/transition.js'),
    import('../../src/auth/pat.js'),
    import('../../src/db/client.js'),
    import('../../src/db/schema.js'),
    import('../../src/middleware/require-pat.js'),
    import('../../src/mcp/tools/lib.js'),
  ]);
  mintSessionToken = tok.mintSessionToken;
  revokeSessionToken = tok.revokeSessionToken;
  applyKernelTransition = trans.applyKernelTransition;
  verifyPat = pat.verifyPat;
  countActivePatsForUser = pat.countActivePatsForUser;
  mintPat = pat.mintPat;
  authenticatePat = mw.authenticatePat;
  principalActor = mcpLib.principalActor;
  dbMod = client;
  schema = sch;

  // cm:why the REAL PATCH handler, mounted as `index.ts` mounts it. Calling `revokeSessionToken` directly would prove the helper works and stay green with the call site deleted from the route — the exact deletion this file exists to catch.
  const { agentSessionRoutes } = await import('../../src/agent-sessions/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
  app = new Hono();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seedSession() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}::uuid, ${project.id}::uuid, 'system', 'running', now())
  `);
  const sessionId = await seedSessionRow(project.id, user.id, runId);
  return { user, project, sessionId, runId };
}

async function seedSessionRow(projectId: string, userId: string, runId: string): Promise<string> {
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, status)
    VALUES (${sessionId}::uuid, ${projectId}::uuid, ${userId}::uuid, ${runId}::uuid, 'running')
  `);
  return sessionId;
}

/** Resolve the token; `null` once it is revoked. */
const alive = async (plaintext: string) => (await verifyPat(plaintext)) !== null;

// cm:guard the chokepoint revoke rides fire-and-forget, exactly as the escalation bridge does, so it lands AFTER `applyKernelTransition` has already resolved — an assertion made straight after that await reads the token still live and would pass for the wrong reason the day the revoke was deleted. Poll to a deadline rather than sleep a fixed span, so a slow box cannot make this flaky in the one direction that hides a leak.
async function deadWithin(plaintext: string, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await alive(plaintext))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function driveTerminal(
  sessionId: string,
  to: 'completed' | 'failed' | 'cancelled_stale' | 'completed_via_recovery',
  reason: string,
): Promise<void> {
  await applyKernelTransition(dbMod.db, {
    entity: 'session',
    to,
    where: sql`${schema.agentSessions.id} = ${sessionId}::uuid
      AND ${schema.agentSessions.status} NOT IN ('completed','failed','cancelled_stale','completed_via_recovery')`,
    reason,
    actor: { type: 'system' },
    source: 'test',
  });
}

describe('a session token is scoped to its project and its principal', () => {
  it('mints under the session user, bound to the session project', async () => {
    const { user, project, sessionId } = await seedSession();
    const plaintext = await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    });
    expect(plaintext).toBeTruthy();

    const verified = await verifyPat(plaintext as string);
    expect(verified?.row.userId).toBe(user.id);
    expect(verified?.row.boundProjectId).toBe(project.id);
    expect(verified?.row.scopes).toEqual(['read', 'write']);
    // cm:guard assert a limit ABOVE the measured peak of one busy session (108 calls in a minute), not the exact number — the point is that an unattended session is not left on a ceiling real traffic already exceeds, since it mints once at cold start and has no way to ask for another.
    expect(verified?.row.rateLimitMax ?? 60).toBeGreaterThan(108);
  });

  // cm:guard the whole family, not just `job:`. A box running the 8 cron schedules mints a token per run under the same user; without the family filter those eat that user's PAT cap and the next token they create by hand is refused with a limit they never approached. This is the case that would have been missed by adding `session:` to `pat-format.ts` and stopping there.
  it('does not count against the user own PAT cap', async () => {
    const { user, project, sessionId } = await seedSession();
    await mintPat({ userId: user.id, name: 'my laptop' });
    expect(await countActivePatsForUser(user.id)).toBe(1);

    await mintSessionToken({ id: sessionId, projectId: project.id, userId: user.id });
    expect(await countActivePatsForUser(user.id)).toBe(1);
  });

  // cm:guard a migration or a re-pin cold-starts the SAME session id, and `pat_user_name_uniq` is on (user_id, name) — so without superseding the previous row the second mint violates the index and takes the whole dispatch down with it. The old token must also be dead: a cold start means the process that held it is gone.
  it('supersedes the previous token when the same session cold-starts again', async () => {
    const { user, project, sessionId } = await seedSession();
    const first = (await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;
    const second = (await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;

    expect(second).not.toBe(first);
    expect(await alive(first)).toBe(false);
    expect(await alive(second)).toBe(true);
  });
});

describe('the token dies with the session, by every route a session can end', () => {
  // cm:guard the chokepoint carries three of the four terminal statuses and NOT the one that matters most. `completed` is here driven through `applyKernelTransition` for completeness, but in production it arrives as a direct `db.update` from the runner's PATCH — which is why the case below exercises `revokeSessionToken` as that handler calls it, rather than trusting this list to cover it.
  it.each([
    ['a dispatch failure or a run-close cascade', 'failed' as const, 'ws_publish_failed'],
    ['the stale-session sweeper', 'cancelled_stale' as const, 'stale'],
    ['a recovery finish', 'completed_via_recovery' as const, 'recovered'],
    ['a chokepoint completion', 'completed' as const, 'pipeline_completed'],
  ])('revokes on %s', async (_label, to, reason) => {
    const { user, project, sessionId } = await seedSession();
    const plaintext = (await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;
    expect(await alive(plaintext)).toBe(true);

    await driveTerminal(sessionId, to, reason);

    expect(await deadWithin(plaintext)).toBe(true);
  });

  // cm:guard THE case this file exists for, and it drives the ROUTE rather than the helper. `PATCH /api/agent-sessions/:id` is the runner's happy-path completion and is a direct `db.update`, so it never reaches `applyKernelTransition` — wire the revoke into the chokepoint alone and every normally-finishing session leaves a live, write-scoped, project-bound credential behind. Verified by planting: deleting `await revokeSessionToken(id)` from that handler turns this red and nothing else in the suite notices.
  it('revokes on the runner happy-path PATCH, which never touches the chokepoint', async () => {
    const { user, project, sessionId } = await seedSession();
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'member',
    });
    const plaintext = (await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;

    const res = await app.request(`http://localhost/api/agent-sessions/${sessionId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await signUserToken(user.id)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(res.status).toBe(200);

    expect(await deadWithin(plaintext)).toBe(true);
    // cm:guard the point is not just that it died — it is that it died WITHOUT the chokepoint. A `kernel_transitions` row here would mean the write had been rerouted through `applyKernelTransition`, which would make this a duplicate of the case above and quietly stop covering the direct-update path.
    const transitions = await dbMod.db.execute(sql`
      SELECT count(*)::int AS n FROM kernel_transitions
      WHERE entity = 'session' AND entity_id = ${sessionId}::uuid
    `);
    expect((transitions as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });

  // cm:guard this covers the REWRITE path, and it does NOT distinguish the two gates — say so rather than let the name imply it. When core turns a reported `completed` into a persisted `failed` (ISS-733 skill-not-synced, `audit_ran_blind`), both values are terminal, so gating on either revokes and no test can tell them apart today. What it does catch is the revoke going missing on the one PATCH shape where the reported and persisted statuses differ at all — a shape nothing else in this suite exercises, and the shape a future rewrite would extend.
  it('revokes when core rewrites the reported status into a different terminal one', async () => {
    const { user, project, sessionId } = await seedSession();
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'member',
    });
    const plaintext = (await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;

    // cm:why this metadata plus an "Unknown command" assistant turn is the ONLY shape that makes core rewrite a reported status (ISS-733: a cold start invoked a skill the runner had not synced). Reproducing it is what gets a PATCH where reported and persisted differ; a plain `status: 'failed'` would not.
    await dbMod.db.execute(sql`
      UPDATE agent_sessions
         SET metadata = jsonb_build_object('pendingSkillName', 'forge-code',
                                           'pendingSkillBaselineCount', 0)
       WHERE id = ${sessionId}::uuid
    `);

    const res = await app.request(`http://localhost/api/agent-sessions/${sessionId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await signUserToken(user.id)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'completed',
        messages: [{ role: 'assistant', content: 'Unknown command: /forge-code' }],
      }),
    });
    expect(res.status).toBe(200);

    const [row] = (await dbMod.db.execute(sql`
      SELECT status FROM agent_sessions WHERE id = ${sessionId}::uuid
    `)) as unknown as Array<{ status: string }>;
    expect(row?.status).toBe('failed');
    expect(await deadWithin(plaintext)).toBe(true);
  });

  it('leaves another session token alone', async () => {
    const { user, project, sessionId, runId } = await seedSession();
    const otherSessionId = await seedSessionRow(project.id, user.id, runId);
    const mine = (await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;
    const theirs = (await mintSessionToken({
      id: otherSessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;

    await driveTerminal(sessionId, 'failed', 'ws_publish_failed');

    expect(await deadWithin(mine)).toBe(true);
    expect(await alive(theirs)).toBe(true);
  });

  it('is idempotent and safe for a session that never held one', async () => {
    const { sessionId } = await seedSession();
    await expect(revokeSessionToken(sessionId)).resolves.toBeUndefined();
    await expect(revokeSessionToken(sessionId)).resolves.toBeUndefined();
  });
});

describe('a session token authenticates as an agent, not as the human who owns it', () => {
  // cm:guard assert through `principalActor`, not on `agency` — the field is not the gate. `mark_merged` and `checkTransitionEvidence` both branch on `principalActor(...).type === 'device'`, so that expression IS the ISS-786/812 scope decision and is the only thing worth pinning. A test that asserted `agency === 'agent'` would stay green through a `principalActor` that ignored the field entirely.
  const gateApplies = (principal: unknown) => principalActor(principal as never).type === 'device';

  const ctx = () =>
    ({ header: () => undefined, req: { header: () => undefined } }) as unknown as Parameters<
      typeof authenticatePat
    >[0];

  it('puts a session token inside the evidence gate', async () => {
    const { user, project, sessionId } = await seedSession();
    const plaintext = (await mintSessionToken({
      id: sessionId,
      projectId: project.id,
      userId: user.id,
    })) as string;

    const principal = await authenticatePat(ctx(), plaintext);
    expect(principal?.agency).toBe('agent');
    expect(gateApplies(principal)).toBe(true);
  });
});
