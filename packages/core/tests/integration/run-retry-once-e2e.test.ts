/**
 * ISS-1050 findings F3 and F4 — a report that arrives twice loses nothing and duplicates nothing.
 *
 * Both halves of one rule, and both are database-shaped, so they live beside a
 * real Postgres rather than a mock. A box retries: it re-sends a declaration
 * whose answer it never received, and it re-reports a checkpoint on every sweep
 * until core takes it. So each write core makes here has to be idempotent in the
 * strong sense — exactly one row however many callers arrive together — and its
 * side effects have to survive the retry rather than being skipped by it.
 *
 * Each test holds the writer's OWN advisory key first and asserts that both
 * callers BLOCK on it. Measured while building this file: two concurrent calls
 * against the unlocked code still produced one comment, because the awaits
 * between the select and the insert let one finish before the other looked. A
 * test that cannot fail proves nothing, and counting rows would have been
 * exactly that.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  writeRunEvidence: typeof import('../../src/devices/run-evidence.js').writeRunEvidence;
  runEvidenceMarker: typeof import('../../src/devices/run-evidence.js').runEvidenceMarker;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  closeRunSession: typeof import('../../src/devices/run-session.js').closeRunSession;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const evidence = await import('../../src/devices/run-evidence.js');
  const runSession = await import('../../src/devices/run-session.js');
  mods = {
    writeRunEvidence: evidence.writeRunEvidence,
    runEvidenceMarker: evidence.runEvidenceMarker,
    openRunSession: runSession.openRunSession,
    closeRunSession: runSession.closeRunSession,
  };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const A_CHECKPOINT = {
  source: 'reconstructed_from_box',
  branch: 'ISS-9-feature',
  head: 'aaaaaaaaaaaa',
  base: 'bbbbbbbbbbbb',
  filesTouched: ['src/one.ts'],
  commitsAhead: 2,
  commitsUnpushed: 1,
  workingTreeDirty: true,
  endedBy: 'reconciler',
  endedReason: 'the run process is gone from this box',
  unread: [],
};

async function anIssue(projectId: string, createdById: string, issSeq: number, next: string) {
  const lease = JSON.stringify({ lease: { next, clock: 1 } });
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, status, session_context)
    VALUES (${projectId}, ${createdById}, ${issSeq}, ${`issue ${issSeq}`},
            'in_progress', ${lease}::jsonb)
    RETURNING id
  `)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error('anIssue: insert returned no row');
  return id;
}

async function bodiesOn(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(
    sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at`,
  )) as unknown as { body: string }[];
  return rows.map((r) => r.body);
}

async function aRunOver(issSeq: number, next: string) {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const device = await createTestDevice(harness.db, user.id);
  const issueId = await anIssue(project.id, user.id, issSeq, next);
  const session = await mods.openRunSession({
    deviceId: device.id,
    projectId: project.id,
    issueKeys: [`ISS-${issSeq}`],
    name: 'run-a',
  });
  return { user, project, device, issueIds: [issueId], session };
}

/** Hold `key` until the returned `release` is called, so two callers can be caught waiting on it. */
async function holding(key: string): Promise<{ release: () => Promise<void> }> {
  let letGo = () => {};
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const holder = harness.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    await held;
  });
  return {
    release: async () => {
      letGo();
      await holder;
    },
  };
}

/** Wait until Postgres itself says both reports are blocked on this issue's marker key. */
async function bothAreWaitingOn(key: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let seen = -1;
  while (Date.now() < deadline) {
    const rows = (await harness.db.execute(sql`
      SELECT count(*)::int AS n
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
         AND objid = (hashtextextended(${key}, 0) & 4294967295)::oid
    `)) as unknown as { n: number }[];
    seen = rows[0]?.n ?? 0;
    if (seen >= 2) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `both callers should be BLOCKED on this key while the harness holds it; ` +
      `Postgres reports ${seen} waiter(s) after 10s. A writer that does not wait on this key is ` +
      `reading around the marker rather than claiming it.`,
  );
}

describe('a report that arrives twice', () => {
  it('makes two reports of one close wait on each other, and writes once', async () => {
    const { device, issueIds, session } = await aRunOver(9, 'twice at once');
    const issueId = issueIds[0] as string;
    const key = `run-evidence:${issueId}:${mods.runEvidenceMarker(session.sessionId)}`;

    const lock = await holding(key);

    const report = () =>
      mods.writeRunEvidence({
        deviceId: device.id,
        sessionId: session.sessionId,
        checkpoint: A_CHECKPOINT,
      });
    const settled: string[] = [];
    const first = report().then((r) => {
      settled.push('first');
      return r;
    });
    const second = report().then((r) => {
      settled.push('second');
      return r;
    });
    await bothAreWaitingOn(key);

    expect(
      settled,
      'a writer that answers while another holds this issue marker key has not claimed it — it has read around it',
    ).toEqual([]);

    await lock.release();
    const both = await Promise.all([first, second]);

    expect(
      (await bodiesOn(issueId)).length,
      'the issue carries one copy of the evidence, whatever the box did',
    ).toBe(1);
    expect(
      both.map((r) => r?.written).sort(),
      'exactly one of the two calls is the one that wrote it',
    ).toEqual([0, 1]);
  });

  it('announces a run whose open event never reached anyone, on the retry that answers with it', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    const declaration = {
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-1'],
      name: 'run-a',
      boxRunId: '77777777-7777-4777-8777-777777777777',
    };

    const first = await mods.openRunSession(declaration);
    const announcedAt = async () => {
      const rows = (await harness.db.execute(
        sql`SELECT metadata->>'runSessionAnnouncedAt' AS at FROM pipeline_runs WHERE id = ${first.runId}`,
      )) as unknown as { at: string | null }[];
      return rows[0]?.at ?? null;
    };
    expect(await announcedAt(), 'an open that succeeded records that it announced').not.toBeNull();

    // The state a failed emit leaves: the run and its session committed, nothing announced.
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET metadata = metadata - 'runSessionAnnouncedAt' WHERE id = ${first.runId}`,
    );
    expect(await announcedAt()).toBeNull();

    const retry = await mods.openRunSession(declaration);

    expect(retry, 'still the same session — this must not open a second one').toEqual(first);
    expect(
      await announcedAt(),
      'the retry is the only thing that will ever announce this run, and it answered without doing so',
    ).not.toBeNull();
  });

  it('does not take an issue back from the run that claimed it after the first return', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const deviceA = await createTestDevice(harness.db, user.id);
    const deviceB = await createTestDevice(harness.db, user.id);
    const issueId = await anIssue(project.id, user.id, 7, 'A was working');
    await harness.db.execute(sql`UPDATE issues SET status = 'open' WHERE id = ${issueId}`);

    const runA = await mods.openRunSession({
      deviceId: deviceA.id,
      projectId: project.id,
      issueKeys: ['ISS-7'],
      name: 'run-a',
    });
    await harness.db.execute(sql`UPDATE issues SET status = 'in_progress' WHERE id = ${issueId}`);

    const firstClose = await mods.closeRunSession({
      deviceId: deviceA.id,
      sessionId: runA.sessionId,
      outcome: 'died',
      detail: 'A died',
    });
    expect(firstClose?.returned, 'the dead run gives its issue back').toEqual(['ISS-7']);

    // B picks the issue up out of the pool, exactly as the next master would.
    const runB = await mods.openRunSession({
      deviceId: deviceB.id,
      projectId: project.id,
      issueKeys: ['ISS-7'],
      name: 'run-b',
    });
    await harness.db.execute(sql`UPDATE issues SET status = 'in_progress' WHERE id = ${issueId}`);

    const retry = await mods.closeRunSession({
      deviceId: deviceA.id,
      sessionId: runA.sessionId,
      outcome: 'died',
      detail: 'A died',
    });

    expect(retry?.alreadyTerminal, "A's session was already closed").toBe(true);
    expect(retry?.returned, 'and there was nothing left for it to give back').toEqual([]);
    const status = (await harness.db.execute(
      sql`SELECT status FROM issues WHERE id = ${issueId}`,
    )) as unknown as { status: string }[];
    expect(
      status[0]?.status,
      "B is working this issue; A's retried close must not pull it back into the pool",
    ).toBe('in_progress');
    expect(runB.sessionId).not.toBe(runA.sessionId);
  });
});
