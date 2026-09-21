/**
 * ISS-1136 — the backfill that gives every existing session row a species.
 *
 * The migration's own statements are read out of the `.sql` and run against
 * seeded rows, rather than restated here: an inference this file carried a copy
 * of would go green over a migration that had stopped saying the same thing,
 * which is the failure mode the whole issue is about.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  ensureMasterSession: typeof import('../../src/devices/master-session.js').ensureMasterSession;
  closeMasterSession: typeof import('../../src/devices/master-session.js').closeMasterSession;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  reapSilentMasters: typeof import('../../src/devices/master-reaper.js').reapSilentMasters;
  reapDeadMasterHolds: typeof import('../../src/devices/master-reaper.js').reapDeadMasterHolds;
  listMasterSessionsForDevice: typeof import('../../src/devices/master-session.js').listMasterSessionsForDevice;
  applyRunLedgerSnapshot: typeof import('../../src/devices/run-ledger.js').applyRunLedgerSnapshot;
  closeSessionsOwnedBy: typeof import('../../src/agent-sessions/session-descent.js').closeSessionsOwnedBy;
  createChatSessionRow: typeof import('../../src/agent-sessions/chat-turn.js').createChatSessionRow;
  SESSION_SILENCE_TIMEOUT_MS: number;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  const masterSession = await import('../../src/devices/master-session.js');
  const runSession = await import('../../src/devices/run-session.js');
  const reaper = await import('../../src/devices/master-reaper.js');
  const ledger = await import('../../src/devices/run-ledger.js');
  const descent = await import('../../src/agent-sessions/session-descent.js');
  const silence = await import('../../src/devices/session-silence.js');
  const chat = await import('../../src/agent-sessions/chat-turn.js');
  mods = {
    ensureMasterSession: masterSession.ensureMasterSession,
    closeMasterSession: masterSession.closeMasterSession,
    openRunSession: runSession.openRunSession,
    reapSilentMasters: reaper.reapSilentMasters,
    reapDeadMasterHolds: reaper.reapDeadMasterHolds,
    listMasterSessionsForDevice: masterSession.listMasterSessionsForDevice,
    applyRunLedgerSnapshot: ledger.applyRunLedgerSnapshot,
    closeSessionsOwnedBy: descent.closeSessionsOwnedBy,
    createChatSessionRow: chat.createChatSessionRow,
    SESSION_SILENCE_TIMEOUT_MS: silence.SESSION_SILENCE_TIMEOUT_MS,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seed() {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const issue = randomUUID();
  await harness.db.execute(sql`
    UPDATE projects SET repo_path = '/tmp/session-identity' WHERE id = ${project.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
    VALUES (${randomUUID()}, ${project.id}, ${device.id}, 'claude-code', 'r', 'online', now())
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${issue}, ${project.id}, 7001, 'the work', 'open', 'high', ${owner.id})
  `);
  return { owner, project, device, issue };
}

/**
 * Everything a refusal says, including the constraint that named it.
 *
 * drizzle wraps the driver's error, so the constraint name is on the cause and
 * not in `err.message` — assert on the wrapper alone and the test passes for a
 * typo in the SQL as readily as for the rule it is about.
 */
function refusal(err: unknown): string {
  const parts: string[] = [];
  let node: unknown = err;
  for (let depth = 0; node && depth < 6; depth += 1) {
    const e = node as { message?: unknown; constraint_name?: unknown; cause?: unknown };
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.constraint_name === 'string') parts.push(e.constraint_name);
    node = e.cause;
  }
  return parts.join(' | ');
}

/** What a rejected write actually said, walked to the bottom of its cause chain. */
async function refusalFor(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return refusal(err);
  }
  throw new Error('the write was accepted, and this assertion is about it being refused');
}

describe('the backfill infers once and says so when it cannot', () => {
  /** The migration's own statements, from the first inference to the abort. */
  function inferenceStatements(): string[] {
    const file = fileURLToPath(
      new URL('../../drizzle/migrations/0295_a_session_says_what_it_is.sql', import.meta.url),
    );
    const all = readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    const abort = all.findIndex((s) => s.includes('five session kinds'));
    expect(abort, 'the migration no longer carries the abort this test is about').toBeGreaterThan(
      0,
    );
    return all
      .slice(0, abort + 1)
      .filter((s) => !/ALTER TABLE "agent_sessions"\s+ADD COLUMN/.test(s));
  }

  /** Run the migration's inference over the rows currently in the table. */
  async function runInference(): Promise<void> {
    for (const statement of inferenceStatements()) {
      await harness.db.execute(sql.raw(statement));
    }
  }

  beforeEach(async () => {
    // The column arrives NOT NULL on a migrated database; the migration itself
    // adds it nullable and sets NOT NULL only after the abort has passed, so
    // this reproduces the state the inference actually runs in.
    await harness.db.execute(sql`ALTER TABLE agent_sessions ALTER COLUMN kind DROP NOT NULL`);
  });

  afterEach(async () => {
    await harness.db.execute(sql`UPDATE agent_sessions SET kind = 'chat' WHERE kind IS NULL`);
    await harness.db.execute(sql`ALTER TABLE agent_sessions ALTER COLUMN kind SET NOT NULL`);
  });

  it('does not let a fork inherit the species of the session it was cut from', async () => {
    const { project, owner } = await seed();
    const row = await mods.createChatSessionRow({ projectId: project.id, userId: owner.id });
    // What `turns-routes.ts` actually writes: `...prevMeta` copies the SOURCE's
    // metadata whole, so a chat forked from a pipeline session carries that
    // session's `type`. Trusting it freezes `pipeline` onto a chat, and no
    // later branch can correct it because they all require `kind IS NULL`.
    await harness.db.execute(sql`
      UPDATE agent_sessions
         SET kind = NULL,
             metadata = COALESCE(metadata, '{}'::jsonb) || '{"type":"pipeline","forkedFromTurnId":"t-1"}'::jsonb
       WHERE id = ${row.id}
    `);

    await runInference();

    const [got] = (await harness.db.execute(
      sql`SELECT kind FROM agent_sessions WHERE id = ${row.id}`,
    )) as unknown as Array<{ kind: string }>;
    expect(got?.kind, 'a fork is an interactive chat, whatever its source was').toBe('chat');
  });

  it('classifies a chat session from its interactive run', async () => {
    const { project, owner } = await seed();
    const row = await mods.createChatSessionRow({ projectId: project.id, userId: owner.id });
    await harness.db.execute(sql`UPDATE agent_sessions SET kind = NULL WHERE id = ${row.id}`);
    await runInference();
    const [after] = (await harness.db.execute(sql`
      SELECT kind FROM agent_sessions WHERE id = ${row.id}
    `)) as unknown as Array<{ kind: string }>;
    expect(after?.kind).toBe('chat');
  });

  it('classifies a run session from the type its run declared', async () => {
    const { project, device } = await seed();
    await mods.ensureMasterSession({ deviceId: device.id, projectId: project.id, name: 'm' });
    const run = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7001'],
      name: 'run-a',
    });
    await harness.db.execute(
      sql`UPDATE agent_sessions SET kind = NULL WHERE id = ${run.sessionId}`,
    );
    await runInference();
    const [after] = (await harness.db.execute(sql`
      SELECT kind FROM agent_sessions WHERE id = ${run.sessionId}
    `)) as unknown as Array<{ kind: string }>;
    expect(after?.kind).toBe('run_session');
  });

  it('aborts naming the row it cannot classify, rather than defaulting it', async () => {
    const { project } = await seed();
    // A system run with no source, no job link and no declared type: no branch
    // of the inference has a positive signal for it. Before the abort, the only
    // way to get this row through was a default — which would then read to
    // every later sweep as a fact core had established.
    const orphanRun = randomUUID();
    const orphan = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${orphanRun}, ${project.id}, 'system', 'running', '{}'::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, metadata)
      VALUES (${orphan}, ${project.id}, ${orphanRun}, NULL, 'running', '{}'::jsonb)
    `);

    const said = await refusalFor(() => runInference());
    expect(said).toMatch(/ISS-1136/);
    expect(said, 'the abort has to name the row, or nobody can go and classify it').toContain(
      orphan,
    );
    expect(said).toMatch(/do not give them a default/i);
  });
});
