/**
 * ISS-933 wave 2 — the central half of a run session, against real Postgres.
 *
 * The box's SQLite ledger is the fast path and cannot be the only one: it lives
 * on the machine whose disappearance is the failure being recovered from. These
 * are the properties that have to hold at core, where a second box can see them.
 *
 * Every one of them is a real query — a jsonb membership read, a NOT NULL
 * `pipeline_run_id`, a device heartbeat compared by Postgres — so a mocked
 * suite could not fail on any of them.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-933 run sessions at core (real Postgres)', () => {
  let harness: TestDatabase;
  let userId: string;
  let projectId: string;
  let deviceId: string;
  let mod: typeof import('../../src/devices/run-session.js');

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    mod = await import('../../src/devices/run-session.js');
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
    deviceId = (await createTestDevice(harness.db, userId, { name: 'run-box' })).id;
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'run-runner', 'claude-code', 'online')
    `);
    await harness.db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${deviceId}`);
  });

  async function insertIssue(seq: number): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`ISS-${seq}`}, 'open', ${userId})
    `);
    return id;
  }

  async function countJobsFor(issueIds: string[]): Promise<number> {
    const rows = (await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM jobs WHERE issue_id = ANY(${sql`ARRAY[${sql.join(
        issueIds.map((i) => sql`${i}::uuid`),
        sql`, `,
      )}]`})
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }

  // cm:guard criterion 4, as corrected on the issue — the measurement is over `jobs`, and it is a COUNT rather than a reasoned absence. `agent_sessions.pipeline_run_id` is NOT NULL, so the row's one-shot `system` run is what that column requires; what must be zero is the job table.
  it('a run carrying a group mints no job for any of its issues', async () => {
    const issues = [await insertIssue(1), await insertIssue(2), await insertIssue(3)];
    const created = await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-attachments',
      issueIds: issues,
      worktreePath: '/repo/.worktrees/attachments',
    });
    expect(created.ok).toBe(true);
    expect(await countJobsFor(issues)).toBe(0);

    const runs = (await harness.db.execute(sql`
      SELECT pr.kind FROM agent_sessions s JOIN pipeline_runs pr ON pr.id = s.pipeline_run_id
      WHERE s.id = ${created.ok ? created.sessionId : ''}
    `)) as unknown as Array<{ kind: string }>;
    expect(runs[0]?.kind).toBe('system');
  });

  // cm:guard criterion 7 — the membership is many-to-many, read BACK off the row rather than off the argument.
  it('the group is readable back off the session row', async () => {
    const issues = [await insertIssue(1), await insertIssue(2), await insertIssue(3)];
    await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-g',
      issueIds: issues,
      worktreePath: '/repo/.worktrees/g',
    });
    const held = await mod.issuesInLiveRuns(projectId);
    expect(held.sort()).toEqual([...issues].sort());
  });

  // cm:guard criterion 9, central half — a SECOND BOX cannot see the first box's ledger, so this is the only thing binding it.
  it('an issue already carried by a live run is refused by name', async () => {
    const shared = await insertIssue(1);
    const other = await insertIssue(2);
    const first = await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-a',
      issueIds: [shared],
      worktreePath: '/repo/.worktrees/a',
    });
    const secondBox = (await createTestDevice(harness.db, userId, { name: 'run-box-2' })).id;
    const second = await mod.createRunSession({
      deviceId: secondBox,
      projectId,
      name: 'forge-run-b',
      issueIds: [shared, other],
      worktreePath: '/repo/.worktrees/b',
    });
    expect(second).toMatchObject({
      ok: false,
      reason: 'issue_in_live_run',
      issueId: shared,
      heldBySessionId: first.ok ? first.sessionId : '',
    });
  });

  it('a closed run holds nothing, so its issues are creatable again', async () => {
    const issue = await insertIssue(1);
    const first = await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-a',
      issueIds: [issue],
      worktreePath: '/repo/.worktrees/a',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await mod.closeRunSession({ deviceId, sessionId: first.sessionId, reason: 'done' })).toBe(
      true,
    );
    const again = await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-a2',
      issueIds: [issue],
      worktreePath: '/repo/.worktrees/a2',
    });
    expect(again.ok).toBe(true);
  });

  it('one box cannot close another box run', async () => {
    const issue = await insertIssue(1);
    const mine = await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-a',
      issueIds: [issue],
      worktreePath: '/repo/.worktrees/a',
    });
    if (!mine.ok) throw new Error('setup');
    const stranger = (await createTestDevice(harness.db, userId, { name: 'stranger' })).id;
    expect(
      await mod.closeRunSession({ deviceId: stranger, sessionId: mine.sessionId, reason: 'mine' }),
    ).toBe(false);
    expect(await mod.issuesInLiveRuns(projectId)).toEqual([issue]);
  });

  // cm:guard criterion 25a — the WHOLE BOX is gone, so nothing local can speak for it. A design in which the unreachable box is the only thing that can release its own work fails here however well it handles a dead pane.
  it('an unreachable box loses its run, and both its issues come back', async () => {
    const issues = [await insertIssue(1), await insertIssue(2)];
    const run = await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-pair',
      issueIds: issues,
      worktreePath: '/repo/.worktrees/pair',
    });
    if (!run.ok) throw new Error('setup');

    expect(await mod.reapRunSessionsOfUnreachableHosts()).toBe(0);

    await harness.db.execute(sql`
      UPDATE devices SET last_seen_at = now() - make_interval(secs => ${
        Math.floor(mod.RUN_SESSION_HOST_TIMEOUT_MS / 1000) + 60
      }) WHERE id = ${deviceId}
    `);
    expect(await mod.reapRunSessionsOfUnreachableHosts()).toBe(1);
    expect(await mod.issuesInLiveRuns(projectId)).toEqual([]);

    const secondBox = (await createTestDevice(harness.db, userId, { name: 'box-2' })).id;
    const taken = await mod.createRunSession({
      deviceId: secondBox,
      projectId,
      name: 'forge-run-pair-2',
      issueIds: issues,
      worktreePath: '/repo/.worktrees/pair-2',
    });
    expect(taken.ok).toBe(true);
  });

  // cm:guard a LIVE box's run is never taken, and this is the half that makes the sweep safe to run every minute. The clock is the DEVICE's, so a run thinking silently for twenty minutes on a healthy box is untouched.
  it('a run on a box that is still answering is left alone', async () => {
    const issue = await insertIssue(1);
    await mod.createRunSession({
      deviceId,
      projectId,
      name: 'forge-run-a',
      issueIds: [issue],
      worktreePath: '/repo/.worktrees/a',
    });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '2 hours'
      WHERE device_id = ${deviceId}
    `);
    expect(await mod.reapRunSessionsOfUnreachableHosts()).toBe(0);
    expect(await mod.issuesInLiveRuns(projectId)).toEqual([issue]);
  });
});
