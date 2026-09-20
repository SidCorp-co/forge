/**
 * ISS-1136 — the five defects a review of this change found, each of them
 * reproduced against a real Postgres before it was fixed.
 *
 * Separate from `session-identity-e2e.test.ts` because they are a different
 * claim: that file says what the issue built, this one says what was wrong with
 * it. Each case below went red first, naming its own rule.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
      row?.status,
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
      name: 'run-a',
    });
    await harness.db.execute(sql`UPDATE issues SET status = 'in_progress' WHERE id = ${issue}`);
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
      session?.status,
      'a run session flipped terminal over issues it never returned is never looked at again',
    ).not.toBe('failed');
    const [row] = (await harness.db.execute(
      sql`SELECT status FROM issues WHERE id = ${issue}`,
    )) as unknown as Array<{ status: string }>;
    expect(row?.status).toBe('in_progress');
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
    expect(row?.held_by).toBe(master.sessionId);
  });
});
