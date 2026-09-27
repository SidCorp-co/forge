/**
 * ISS-1245 — the one fact that ends a run its box cannot otherwise close.
 *
 * A run under a live master is KEPT by the daemon, and the keep beats the run's
 * session on every sweep, so core's `agent_sessions` row never goes stale, so
 * core never calls the session over, so the keep never ends. The run is alive
 * because the box says so and the box says so because the run is alive.
 *
 * The issue's own status is the only fact outside that loop, and this is the
 * read a box makes it through — on the lease call the close loop already makes,
 * so it costs no route of its own. Measured on one box 2026-09-25: two runs
 * holding unreturned leases on issues that had closed eight hours earlier.
 *
 * These need a real Postgres: the answer is a join over `issues` and the
 * per-project `iss_seq`, and `closed` is guarded by a database trigger.
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
let readDeviceIssueLease: typeof import('../../src/issues/issue-lease.js').readDeviceIssueLease;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  ({ readDeviceIssueLease } = await import('../../src/issues/issue-lease.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** One project this box serves, holding one issue at `iss_seq` 880. */
async function oneBoxOnOneIssue() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const box = await createTestDevice(harness.db, user.id);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status)
    VALUES (gen_random_uuid(), ${project.id}, ${box.id}, 'ra', 'claude-code', 'online')
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (gen_random_uuid(), ${project.id}, 880, 'issue 880', 'draft', ${user.id})
  `);
  return { user, project, box };
}

/** The status a box is asking about, set the way the database will accept it. */
async function setStatus(projectId: string, status: 'closed' | 'dropped' | 'in_progress') {
  const merged = status === 'closed' ? sql`, merged_at = now()` : sql.empty();
  await harness.db.execute(sql`
    UPDATE issues SET status = ${status}${merged}
     WHERE project_id = ${projectId} AND iss_seq = 880
  `);
}

describe('what one box is told about the issue behind a lease', () => {
  it('says the issue is over once it reaches a terminal status', async () => {
    const { project, box } = await oneBoxOnOneIssue();
    await setStatus(project.id, 'closed');

    const seen = await readDeviceIssueLease({
      deviceId: box.id,
      issueKey: 'ISS-880',
      projectId: project.id,
    });

    expect(seen.issueOver).toBe(true);
  });

  it('counts a dropped issue over too', async () => {
    const { project, box } = await oneBoxOnOneIssue();
    await setStatus(project.id, 'dropped');

    expect(
      (await readDeviceIssueLease({ deviceId: box.id, issueKey: 'ISS-880', projectId: project.id }))
        .issueOver,
      'nothing further will be done on it, whichever exit it took',
    ).toBe(true);
  });

  it('does not call a live issue over', async () => {
    const { project, box } = await oneBoxOnOneIssue();
    await setStatus(project.id, 'in_progress');

    expect(
      (await readDeviceIssueLease({ deviceId: box.id, issueKey: 'ISS-880', projectId: project.id }))
        .issueOver,
      'a box that reads a live issue as over closes a run somebody is using',
    ).toBe(false);
  });

  it('answers off the issue, so a lease already freed still carries it', async () => {
    const { project, box } = await oneBoxOnOneIssue();
    await setStatus(project.id, 'closed');

    const seen = await readDeviceIssueLease({
      deviceId: box.id,
      issueKey: 'ISS-880',
      projectId: project.id,
    });

    expect(seen.held, 'no run session was ever opened over it').toBe(false);
    expect(
      seen.issueOver,
      'the rows that most need this fact are the ones whose lease core already freed, and an early return on the lease row would answer null for every one of them',
    ).toBe(true);
  });

  it('leaves the issue unknown where the request names no project', async () => {
    const { project, box } = await oneBoxOnOneIssue();
    await setStatus(project.id, 'closed');

    expect(
      (await readDeviceIssueLease({ deviceId: box.id, issueKey: 'ISS-880' })).issueOver,
      '`iss_seq` restarts per project, so a request naming none identifies no issue, and a guess here closes the wrong project run',
    ).toBe(null);
  });

  it('leaves the issue unknown where the key reaches no issue', async () => {
    const { project, box } = await oneBoxOnOneIssue();

    expect(
      (await readDeviceIssueLease({ deviceId: box.id, issueKey: 'ISS-999', projectId: project.id }))
        .issueOver,
      'a key that reaches nothing is not an issue that is live',
    ).toBe(null);
  });
});
