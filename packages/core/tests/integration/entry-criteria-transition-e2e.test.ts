/**
 * ISS-959 C — a status is checked against declared entry criteria, from any
 * client.
 *
 * The rule that matters is WHO it holds against: every entry rule core had
 * before this short-circuited on `agency !== 'agent'`, so the same status set
 * from the tracker's own screens was neither earned nor refused. These cases
 * drive the REST transition route as a signed-in PERSON, which is the actor
 * the old carve-out exempted, against a project whose declaration is stored
 * where a project stores it.
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

type Mods = {
  transitionRoutes: typeof import('../../src/issues/transition.js')['transitionRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

describe('ISS-959 C — declared entry criteria, checked for every client', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

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

    const [transitionMod, jwtMod, errMod] = await Promise.all([
      import('../../src/issues/transition.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      transitionRoutes: transitionMod.transitionRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
    };
    app = new Hono();
    app.route('/api/issues', mods.transitionRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed(opts: {
    statusEntryCriteria?: Record<string, string[]>;
    status?: string;
    plan?: string | null;
    releaseNotes?: Record<string, unknown> | null;
  }) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    if (opts.statusEntryCriteria) {
      await harness.db.execute(sql`
        UPDATE projects
        SET agent_config = ${JSON.stringify({
          pipelineConfig: { statusEntryCriteria: opts.statusEntryCriteria },
        })}::jsonb
        WHERE id = ${project.id}
      `);
    }
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, plan, release_notes)
      VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)}, 'criteria',
              ${opts.status ?? 'in_progress'}, ${user.id}, ${opts.plan ?? null},
              ${opts.releaseNotes ? JSON.stringify(opts.releaseNotes) : null}::jsonb)
    `);
    const token = await mods.signUserToken(user.id);
    return { id, token, projectId: project.id };
  }

  function transition(id: string, token: string, toStatus: string) {
    return app.request(`/api/issues/${id}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ toStatus }),
    });
  }

  async function storedStatus(id: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${id}`,
    );
    return (rows[0] as { status: string }).status;
  }

  it('AC18 — a project declaring nothing transitions exactly as before this change', async () => {
    const { id, token } = await seed({});
    const res = await transition(id, token, 'on_hold');
    expect(res.status).toBe(200);
    expect(await storedStatus(id)).toBe('on_hold');
  });

  it('AC19/AC23 — a signed-in PERSON is refused 422 ENTRY_CRITERIA_UNMET on an unmet declared criterion', async () => {
    const { id, token } = await seed({ statusEntryCriteria: { on_hold: ['plan'] } });
    const res = await transition(id, token, 'on_hold');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(await storedStatus(id)).toBe('in_progress');
  });

  it('AC20 — the refusal names the record that is missing, and how to write it', async () => {
    const { id, token } = await seed({ statusEntryCriteria: { on_hold: ['release_note'] } });
    const res = await transition(id, token, 'on_hold');
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('release_note');
    expect(body.message).toContain('`releaseNotes`');
  });

  it('AC21 — the refusal names only the unmet criteria, never every criterion the status declares', async () => {
    const { id, token } = await seed({
      statusEntryCriteria: { on_hold: ['plan', 'release_note'] },
      plan: 'the plan is written',
    });
    const res = await transition(id, token, 'on_hold');
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('release_note');
    expect(body.message).not.toContain('plan —');
    expect(body.message).toContain('a record');
  });

  it('AC22 — the same transition succeeds once the named record is written', async () => {
    const { id, token } = await seed({ statusEntryCriteria: { on_hold: ['plan'] } });
    expect((await transition(id, token, 'on_hold')).status).toBe(422);

    await harness.db.execute(sql`UPDATE issues SET plan = 'the plan' WHERE id = ${id}`);

    const res = await transition(id, token, 'on_hold');
    expect(res.status).toBe(200);
    expect(await storedStatus(id)).toBe('on_hold');
  });

  it('checks the status the actor ASKED for, not some other status the project declared', async () => {
    const { id, token } = await seed({ statusEntryCriteria: { closed: ['plan'] } });
    const res = await transition(id, token, 'on_hold');
    expect(res.status).toBe(200);
  });

  it('holds a declared `merged_mark` against a person, and passes once the mark is stamped', async () => {
    const { id, token } = await seed({ statusEntryCriteria: { on_hold: ['merged_mark'] } });
    expect((await transition(id, token, 'on_hold')).status).toBe(422);

    await harness.db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${id}`);
    expect((await transition(id, token, 'on_hold')).status).toBe(200);
  });

  it('holds a declared `work_evidence` against a person — the rule the agent-only carve-out exempts them from', async () => {
    const { id, token, projectId } = await seed({
      statusEntryCriteria: { on_hold: ['work_evidence'] },
    });
    expect((await transition(id, token, 'on_hold')).status).toBe(422);

    await harness.db.execute(sql`
      UPDATE issues SET session_context = ${JSON.stringify({ branch: 'ISS-959-work' })}::jsonb
      WHERE id = ${id}
    `);
    void projectId;
    expect((await transition(id, token, 'on_hold')).status).toBe(200);
  });

  it('leaves a project whose stored config does not parse transitioning as before', async () => {
    const { id, token, projectId } = await seed({});
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({
        pipelineConfig: { statusEntryCriteria: { on_hold: ['not_a_criterion'] } },
      })}::jsonb WHERE id = ${projectId}
    `);
    const res = await transition(id, token, 'on_hold');
    expect(res.status).toBe(200);
  });
});
