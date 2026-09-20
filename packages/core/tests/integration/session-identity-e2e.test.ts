/**
 * ISS-1136 — what a session row says about itself, against a real Postgres.
 *
 * Four things that could only fail in a runtime with a database: a NOT NULL
 * column and a check constraint, a partial unique index over a live master, a
 * foreign key that refuses a parent core never issued, and a descent that
 * closes a subtree and hands its issue leases back. None of those can go red in
 * a mocked runtime, so a green there would have been no evidence at all.
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

/** A session row written straight to SQL, so the column itself can refuse it. */
async function rawSession(args: {
  projectId: string;
  kind?: string | null;
  deviceId?: string | null;
  parent?: string | null;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  const run = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${run}, ${args.projectId}, 'system', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, parent_session_id, status)
    VALUES (${id}, ${args.projectId}, ${args.deviceId ?? null}, ${run},
            ${args.kind ?? null}, ${args.parent ?? null}, ${args.status ?? 'running'})
  `);
  return id;
}

describe('a session row states its own species', () => {
  it('refuses a row that does not say what kind it is', async () => {
    const { project } = await seed();
    expect(await refusalFor(() => rawSession({ projectId: project.id, kind: null }))).toMatch(
      /null value in column "kind"/i,
    );
  });

  it('refuses a kind outside the vocabulary rather than storing it', async () => {
    const { project } = await seed();
    // 'agent' is the value the session list route filtered on for two years and
    // no writer in this repository ever set.
    expect(await refusalFor(() => rawSession({ projectId: project.id, kind: 'agent' }))).toMatch(
      /agent_sessions_kind_check/i,
    );
  });

  it('gives a chat session a kind a sweep can see, which the jsonb key never did', async () => {
    const { project, owner } = await seed();
    const row = await mods.createChatSessionRow({ projectId: project.id, userId: owner.id });
    expect(row.kind).toBe('chat');
    const seen = (await harness.db.execute(sql`
      SELECT s.id FROM agent_sessions s WHERE s.kind = 'chat' AND s.id = ${row.id}
    `)) as unknown as Array<{ id: string }>;
    expect(seen).toHaveLength(1);
    // The reading that was impossible before: neither chat writer set a
    // `metadata.type`, so `metadata->>'type'` answered NULL for every one of
    // them and any sweep keyed on it skipped the row in silence.
    const byOldReading = (await harness.db.execute(sql`
      SELECT s.id FROM agent_sessions s WHERE s.metadata->>'type' = 'chat' AND s.id = ${row.id}
    `)) as unknown as Array<{ id: string }>;
    expect(byOldReading).toHaveLength(0);
  });
});

describe('core issues the owner edge', () => {
  it('opens a run session under the live master for its device and project', async () => {
    const { project, device } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    const run = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7001'],
      name: 'run-a',
    });
    const [row] = (await harness.db.execute(sql`
      SELECT kind, parent_session_id FROM agent_sessions WHERE id = ${run.sessionId}
    `)) as unknown as Array<{ kind: string; parent_session_id: string | null }>;
    expect(row?.kind).toBe('run_session');
    expect(row?.parent_session_id).toBe(master.sessionId);
  });

  it('keeps one live master per device and project, whichever registration wins the race', async () => {
    const { project, device } = await seed();
    const [a, b, c] = await Promise.all([
      mods.ensureMasterSession({ deviceId: device.id, projectId: project.id, name: 'm' }),
      mods.ensureMasterSession({ deviceId: device.id, projectId: project.id, name: 'm' }),
      mods.ensureMasterSession({ deviceId: device.id, projectId: project.id, name: 'm' }),
    ]);
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(1);
    const rows = (await harness.db.execute(sql`
      SELECT id FROM agent_sessions WHERE kind = 'master' AND project_id = ${project.id}
    `)) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('refuses a second live master for one device and project at the index', async () => {
    const { project, device } = await seed();
    await mods.ensureMasterSession({ deviceId: device.id, projectId: project.id, name: 'm' });
    expect(
      await refusalFor(() =>
        rawSession({ projectId: project.id, deviceId: device.id, kind: 'master' }),
      ),
    ).toMatch(/agent_sessions_one_live_master_uq/i);
  });

  it('refuses a parent that names no session at all', async () => {
    const { project } = await seed();
    expect(
      await refusalFor(() =>
        rawSession({ projectId: project.id, kind: 'chat', parent: randomUUID() }),
      ),
    ).toMatch(/agent_sessions_parent_session_id_fkey/i);
  });
});

describe("the box's reported master is corroboration, never the record", () => {
  function ledgerEntry(projectId: string, masterSessionId: string | null) {
    return {
      runId: 'box-run-1',
      projectId,
      sessionId: null,
      masterSessionId,
      pid: 4242,
      worktreePath: '/tmp/wt',
      bootId: 'boot-1',
      incarnation: 'live',
      work: 'runnable',
      blockerKind: null,
      waitingOn: null,
      sessionTerminalAtEpochS: null,
      worktreeGoneAtEpochS: null,
      issues: [],
    };
  }

  it('refuses a master core never issued, and still records the run', async () => {
    const { project, device } = await seed();
    await mods.applyRunLedgerSnapshot({
      deviceId: device.id,
      entries: [ledgerEntry(project.id, randomUUID())],
    });
    const [row] = (await harness.db.execute(sql`
      SELECT run_id, master_session_id FROM device_run_ledger WHERE device_id = ${device.id}
    `)) as unknown as Array<{ run_id: string; master_session_id: string | null }>;
    expect(row?.run_id, 'the observation survives; only the edge is refused').toBe('box-run-1');
    expect(row?.master_session_id).toBeNull();
  });

  it('refuses a real session that is a master of another box', async () => {
    const { project, device, owner } = await seed();
    const otherBox = await createTestDevice(harness.db, owner.id);
    const foreign = await mods.ensureMasterSession({
      deviceId: otherBox.id,
      projectId: project.id,
      name: 'm-elsewhere',
    });
    await mods.applyRunLedgerSnapshot({
      deviceId: device.id,
      entries: [ledgerEntry(project.id, foreign.sessionId)],
    });
    const [row] = (await harness.db.execute(sql`
      SELECT master_session_id FROM device_run_ledger WHERE device_id = ${device.id}
    `)) as unknown as Array<{ master_session_id: string | null }>;
    expect(
      row?.master_session_id,
      'the foreign key would have accepted this, because the row exists. What refuses it is that it is not a master of THIS box',
    ).toBeNull();
  });

  it('stores a master this box really does hold', async () => {
    const { project, device } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'm',
    });
    await mods.applyRunLedgerSnapshot({
      deviceId: device.id,
      entries: [ledgerEntry(project.id, master.sessionId)],
    });
    const [row] = (await harness.db.execute(sql`
      SELECT master_session_id FROM device_run_ledger WHERE device_id = ${device.id}
    `)) as unknown as Array<{ master_session_id: string | null }>;
    expect(row?.master_session_id).toBe(master.sessionId);
  });
});

describe('liveness descends', () => {
  it('closes the run a closed master owned, and hands its issue back', async () => {
    const { project, device } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'm',
    });
    const run = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7001'],
      name: 'run-a',
    });
    // What the run's own agent does on its way in, and what ISS-457 was left
    // standing at for 18 hours with no process behind it.
    await harness.db.execute(sql`
      UPDATE issues SET status = 'in_progress'
       WHERE project_id = ${project.id} AND iss_seq = 7001
    `);

    await mods.closeMasterSession({
      deviceId: device.id,
      sessionId: master.sessionId,
      reason: 'the daemon saw the pane go',
    });

    const [child] = (await harness.db.execute(sql`
      SELECT status, failure_reason FROM agent_sessions WHERE id = ${run.sessionId}
    `)) as unknown as Array<{ status: string; failure_reason: string | null }>;
    expect(
      child?.status,
      'a child runs inside its parent, so an open child under a closed parent is a corpse',
    ).toBe('failed');
    expect(child?.failure_reason).toBe('session_lost');

    const [issue] = (await harness.db.execute(sql`
      SELECT status FROM issues WHERE project_id = ${project.id} AND iss_seq = 7001
    `)) as unknown as Array<{ status: string }>;
    expect(
      issue?.status,
      'the issue the run was carrying went back to where it was claimed from',
    ).toBe('open');
  });

  it('stops at its depth bound rather than walking a cycle forever', async () => {
    const { project } = await seed();
    const a = await rawSession({ projectId: project.id, kind: 'chat' });
    const b = await rawSession({ projectId: project.id, kind: 'chat', parent: a });
    // Nothing in the schema forbids a cycle, and a walk that met one without a
    // bound would not terminate.
    await harness.db.execute(sql`
      UPDATE agent_sessions SET parent_session_id = ${b} WHERE id = ${a}
    `);
    const result = await mods.closeSessionsOwnedBy([a], {
      reason: 'test_cycle',
      detail: 'session-descent: a deliberate cycle',
    });
    expect(result.closed).toContain(b);
  });
});

describe('a master is only silent when its whole tree is', () => {
  async function silenceSession(id: string, ms: number) {
    await harness.db.execute(sql`
      UPDATE agent_sessions
         SET last_heartbeat_at = now() - make_interval(secs => ${Math.floor(ms / 1000)}),
             started_at = now() - make_interval(secs => ${Math.floor(ms / 1000)}),
             created_at = now() - make_interval(secs => ${Math.floor(ms / 1000)})
       WHERE id = ${id}
    `);
  }

  it('closes a master whose tree has stopped answering, and closes what it owned', async () => {
    const { project, device } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'm',
    });
    const run = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7001'],
      name: 'run-a',
    });
    const past = mods.SESSION_SILENCE_TIMEOUT_MS + 60_000;
    await silenceSession(master.sessionId, past);
    await silenceSession(run.sessionId, past);

    expect(await mods.reapSilentMasters()).toBe(1);
    const rows = (await harness.db.execute(sql`
      SELECT id, status FROM agent_sessions
       WHERE id IN (${master.sessionId}, ${run.sessionId})
    `)) as unknown as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.status).toBe('failed');
  });

  it('leaves a silent master standing while a run it owns is still beating', async () => {
    const { project, device } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'm',
    });
    const run = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7001'],
      name: 'run-a',
    });
    await silenceSession(master.sessionId, mods.SESSION_SILENCE_TIMEOUT_MS + 60_000);
    // The box is alive; it is the master's own heartbeat path that is broken.
    // Reaping here would return a lease under a run that is still working,
    // which is the one failure the single clock exists to avoid.
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() WHERE id = ${run.sessionId}
    `);

    expect(await mods.reapSilentMasters()).toBe(0);
    const [row] = (await harness.db.execute(sql`
      SELECT status FROM agent_sessions WHERE id = ${master.sessionId}
    `)) as unknown as Array<{ status: string }>;
    expect(row?.status).toBe('running');
  });
});

describe('the backfill infers once and says so when it cannot', () => {
  /**
   * The migration's own statements, from the first inference to the abort.
   *
   * Read out of the file rather than restated here: an inference this test
   * carried a copy of would go green over a migration that had stopped saying
   * the same thing, which is the failure mode the whole issue is about.
   */
  function inferenceStatements(): string[] {
    const file = fileURLToPath(
      new URL('../../drizzle/migrations/0293_a_session_says_what_it_is.sql', import.meta.url),
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
    expect(got.kind, 'a fork is an interactive chat, whatever its source was').toBe('chat');
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

/**
 * The five the review found, each reproduced before it was fixed.
 *
 * Every one of these went red first on the code as written, naming the rule it
 * is about — a green here is only worth what the red before it was.
 */
describe('what the review found', () => {
  it('lists only masters for a device, not every live session on the box', async () => {
    const { project, device } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'the-master-pane',
    });
    // A live run session and a live chat on the SAME box. Before the kind
    // predicate this query was device + live-status alone, so the daemon's
    // reconcile was handed all three and told they were masters.
    await rawSession({ projectId: project.id, deviceId: device.id, kind: 'run_session' });
    await rawSession({ projectId: project.id, deviceId: device.id, kind: 'chat' });

    const listed = await mods.listMasterSessionsForDevice(device.id);

    expect(listed.map((r) => r.sessionId)).toEqual([master.sessionId]);
  });

  it('walks through a terminal session to close the live one underneath it', async () => {
    const { project, device } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'the-master-pane',
    });
    // The ordinary shape: a fork or a rerun names a source that has finished.
    const finished = await rawSession({
      projectId: project.id,
      deviceId: device.id,
      kind: 'chat',
      parent: master.sessionId,
      status: 'completed',
    });
    const live = await rawSession({
      projectId: project.id,
      deviceId: device.id,
      kind: 'chat',
      parent: finished,
      status: 'running',
    });

    await mods.closeSessionsOwnedBy([master.sessionId], {
      reason: 'owner_session_closed',
      detail: 'the test closed the owner',
    });

    const [row] = (await harness.db.execute(
      sql`SELECT status FROM agent_sessions WHERE id = ${live}`,
    )) as unknown as Array<{ status: string }>;
    expect(
      row.status,
      'a live session under a terminal one is still owned by the root, and the closure claims to be transitive',
    ).toBe('failed');
  });

  it('leaves a run session open when its issues could not be given back', async () => {
    const { project, device, issue } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'the-master-pane',
    });
    const opened = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7001'],
    });
    await harness.db.execute(
      sql`UPDATE issues SET status = 'in_progress' WHERE id = ${issue}`,
    );
    // `runIssues` is read as an array on both sides of the return. An object
    // there makes the read raise rather than answer nothing, which is the shape
    // of any failure in this path: it happens BEFORE the flip, or not at all.
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = jsonb_set(metadata, '{runIssues}', '{"not":"an array"}'::jsonb)
       WHERE id = ${opened.runId}
    `);

    await mods.closeSessionsOwnedBy([master.sessionId], {
      reason: 'owner_session_closed',
      detail: 'the test closed the owner',
    });

    const [session] = (await harness.db.execute(
      sql`SELECT status FROM agent_sessions WHERE id = ${opened.sessionId}`,
    )) as unknown as Array<{ status: string }>;
    expect(
      session.status,
      'a run session flipped terminal over issues it never returned is never looked at again',
    ).not.toBe('failed');
    const [row] = (await harness.db.execute(
      sql`SELECT status FROM issues WHERE id = ${issue}`,
    )) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('in_progress');
  });

  it('keeps a stale master holding its jobs while a run it owns is still beating', async () => {
    const { project, device, owner, issue } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'the-master-pane',
    });
    const child = await rawSession({
      projectId: project.id,
      deviceId: device.id,
      kind: 'run_session',
      parent: master.sessionId,
    });
    const job = randomUUID();
    const jobRun = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status)
      VALUES (${jobRun}, ${project.id}, 'system', 'running')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by,
                        queued_at, held_by, held_at)
      VALUES (${job}, ${project.id}, ${issue}, ${jobRun}, 'code', 'queued', ${owner.id}, now(),
              ${master.sessionId}, now())
    `);
    const staleSecs = Math.floor(mods.SESSION_SILENCE_TIMEOUT_MS / 1000) + 60;
    await harness.db.execute(sql`
      UPDATE agent_sessions
         SET last_heartbeat_at = now() - make_interval(secs => ${staleSecs}),
             started_at = now() - make_interval(secs => ${staleSecs})
       WHERE id = ${master.sessionId}
    `);
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() WHERE id = ${child}
    `);

    const released = await mods.reapDeadMasterHolds();

    expect(
      released,
      'the hold sweep undid the protection reapSilentMasters had just given this box',
    ).toBe(0);
    const [row] = (await harness.db.execute(
      sql`SELECT held_by FROM jobs WHERE id = ${job}`,
    )) as unknown as Array<{ held_by: string | null }>;
    expect(row.held_by).toBe(master.sessionId);
  });
});
