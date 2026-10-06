/**
 * ISS-1109 — who is working an issue is a row a constraint refuses (`issue_leases`), taken all or
 * none per group (`issues/issue-lease.ts:takeIssueLeases`) and given back for the one project it was
 * taken for (`releaseIssueLeaseRow`). Against Postgres: the primary key, the per-key order and the
 * transaction are the rule.
 */

import { randomUUID } from 'node:crypto';
import { RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import {
  issueWorkInFlightSql,
  releaseIssueLeaseRow,
  takeIssueLeases,
} from '../../src/issues/issue-lease.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
});

interface Box {
  deviceId: string;
  sessionId: string;
  runId: string;
}

/** A box with a live run session over this project, as a run session opens one. */
async function box(project = projectId): Promise<Box> {
  const deviceId = await createTestDevice(ownerId);
  const runId = randomUUID();
  const sessionId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${project}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, device_id)
    VALUES (${sessionId}, ${project}, ${ownerId}, ${runId}, ${RUN_SESSION_KIND}, 'running', ${deviceId})
  `);
  return { deviceId, sessionId, runId };
}

const take = (b: Box, issueKeys: string[], project = projectId) =>
  db.transaction((tx) => takeIssueLeases(tx, { projectId: project, ...b, issueKeys }));

const give = (b: Box, issueKey: string, project?: string) =>
  db.transaction((tx) =>
    releaseIssueLeaseRow(tx, { deviceId: b.deviceId, issueKey, projectId: project ?? null }),
  );

async function holders(
  project = projectId,
): Promise<Array<{ issue_key: string; session_id: string }>> {
  return rows(sql`
    SELECT issue_key, session_id FROM issue_leases WHERE project_id = ${project} ORDER BY issue_key
  `);
}

async function endSession(b: Box): Promise<void> {
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${b.sessionId}`),
  );
}

describe('taking a group of issues', () => {
  it('takes every key of a free group', async () => {
    const a = await box();
    await take(a, ['ISS-2', 'ISS-1']);
    expect(await holders()).toEqual([
      { issue_key: 'ISS-1', session_id: a.sessionId },
      { issue_key: 'ISS-2', session_id: a.sessionId },
    ]);
  });

  it('refuses a group one of whose keys another box holds, naming that box, and takes none of it', async () => {
    const a = await box();
    const b = await box();
    await take(a, ['ISS-2']);

    await expect(take(b, ['ISS-1', 'ISS-2', 'ISS-3'])).rejects.toThrow(
      new RegExp(`ISS-2 is held by another box \\(device ${a.deviceId}\\)`),
    );

    expect(await holders()).toEqual([{ issue_key: 'ISS-2', session_id: a.sessionId }]);
  });

  it('tells a box that already holds the key that the holder is itself, and to close that session', async () => {
    const a = await box();
    await take(a, ['ISS-1']);
    const again = { ...(await box()), deviceId: a.deviceId };

    const refused = await take(again, ['ISS-1']).then(
      () => '',
      (err: unknown) => String((err as Error).message),
    );

    expect(refused).toContain(
      `ISS-1 is held by this same box (device ${a.deviceId}), under run session ${a.sessionId}`,
    );
    expect(refused).toContain('Close that run session before opening another over the same issues');
  });

  it('takes a key whose holder’s session has ended', async () => {
    const a = await box();
    const b = await box();
    await take(a, ['ISS-1']);
    await endSession(a);

    await take(b, ['ISS-1']);

    expect(await holders()).toEqual([{ issue_key: 'ISS-1', session_id: b.sessionId }]);
  });

  it('lets two boxes taking overlapping groups in opposite orders end with one holder each key, never a deadlock', async () => {
    const a = await box();
    const b = await box();

    const results = await Promise.allSettled([
      take(a, ['ISS-1', 'ISS-2', 'ISS-3']),
      take(b, ['ISS-3', 'ISS-2', 'ISS-1']),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String((lost[0] as PromiseRejectedResult).reason)).not.toMatch(/deadlock/i);
    expect(new Set((await holders()).map((h) => h.session_id)).size).toBe(1);
  });

  it('keeps one project’s key apart from the same key in another project', async () => {
    const other = (await createTestProject(ownerId)).id;
    const a = await box();
    const b = await box(other);
    await take(a, ['ISS-1']);
    await take(b, ['ISS-1'], other);
    expect(await holders()).toHaveLength(1);
    expect(await holders(other)).toHaveLength(1);
  });
});

describe('giving one issue back', () => {
  it('releases the key for the project it was taken for', async () => {
    const a = await box();
    await take(a, ['ISS-1', 'ISS-2']);

    expect(await give(a, 'ISS-1')).toEqual({ released: true, projectId });
    expect((await holders()).map((h) => h.issue_key)).toEqual(['ISS-2']);
  });

  it('answers not_held for a key the box does not hold, and removes nothing', async () => {
    const a = await box();
    const b = await box();
    await take(a, ['ISS-1']);

    expect(await give(b, 'ISS-1')).toEqual({ released: false, reason: 'not_held', projectIds: [] });
    expect(await holders()).toHaveLength(1);
  });

  it('answers ambiguous where one box holds the key in two projects, until the project is named', async () => {
    const other = (await createTestProject(ownerId)).id;
    const a = await box();
    const inOther = { ...(await box(other)), deviceId: a.deviceId };
    await take(a, ['ISS-1']);
    await take(inOther, ['ISS-1'], other);

    const vague = await give(a, 'ISS-1');
    expect(vague).toMatchObject({ released: false, reason: 'ambiguous' });
    expect(await holders()).toHaveLength(1);
    expect(await holders(other)).toHaveLength(1);

    expect(await give(a, 'ISS-1', other)).toEqual({ released: true, projectId: other });
    expect(await holders()).toHaveLength(1);
    expect(await holders(other)).toHaveLength(0);
  });
});

describe('what a lease says about the work', () => {
  it('reads an issue as in flight while a live session holds its lease, and not once it ends', async () => {
    const [issue] = await rows<{ id: string; key: string }>(sql`
      INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
      VALUES (${projectId}, 7, 'leased', 'open', ${ownerId})
      RETURNING id, 'ISS-' || iss_seq AS key
    `);
    const inFlight = async () => {
      const [row] = await rows<{ busy: boolean }>(sql`
        SELECT ${issueWorkInFlightSql({ issueId: String(issue?.id), projectId, issueKey: String(issue?.key) })} AS busy
      `);
      return row?.busy;
    };
    const a = await box();
    expect(await inFlight()).toBe(false);

    await take(a, [String(issue?.key)]);
    expect(await inFlight()).toBe(true);

    await endSession(a);
    expect(await inFlight()).toBe(false);
  });
});
