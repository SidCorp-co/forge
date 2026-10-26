/**
 * A run sending the same verdict again writes nothing (coordinator ruling 2026-10-26). adminhub-fe
 * ISS-51's criterion 1 was posted twice word for word by one run, and two rows stood. A verdict the
 * same in criterion, verdict, identity, run session, reason, evidence, judge and probe as that run's
 * latest on the criterion answers 200 with the existing row and `duplicate: true`. A different
 * reason, another run, or a verdict sent again after a different one is a new row. Through the
 * app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/verdict-repeat.ts
 */

import { randomUUID } from 'node:crypto';
import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const LIVE = '0d91ae7c74f70295ede115463b17559e650b5207';

let projectId: string;
let ownerId: string;
let token: string;
let box: string;
let boxToken: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  box = await createTestDevice(ownerId);
  boxToken = (await mintPat({ permissions: ['*'], userId: ownerId, name: 'box', deviceId: box }))
    .plaintext;
  unplant = plantLiveBuild(LIVE);
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

/** A run session on the box holding `key`'s lease, as a box opens one; answers its session id. */
async function runHolding(key: string): Promise<string> {
  return (await runWithId(key)).session;
}

/** As `runHolding`, also answering the box's own run id, which a verdict names in `run`. */
async function runWithId(key: string): Promise<{ session: string; boxRunId: string }> {
  const runId = randomUUID();
  const boxRunId = randomUUID();
  const metadata = {
    boxRunId,
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: 'in_progress' },
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', now(), ${JSON.stringify(metadata)}::jsonb)`);
  const [s] = await rows<{ id: string }>(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${projectId}, ${box}, ${runId}, 'run_session', 'running', now(), now())
    RETURNING id`);
  if (!s) throw new Error('no run session seeded');
  await db.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
    VALUES (${projectId}, ${key}, ${box}, ${s.id}, ${runId})
    ON CONFLICT (project_id, issue_key)
    DO UPDATE SET device_id = EXCLUDED.device_id, session_id = EXCLUDED.session_id,
                  run_id = EXCLUDED.run_id, acquired_at = now()`);
  return { session: s.id, boxRunId };
}

async function issue(): Promise<{ id: string; key: string }> {
  const made = await createTestIssue(projectId, ownerId, 1, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  const put = await api(token, 'PUT', `/api/issues/${made.id}/criteria`, {
    criteria: [{ statement: 'The Orders list shows every order' }],
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return made;
}

const verdict = (issueId: string, extra: Doc = {}) =>
  api(boxToken, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'every order is listed on the running build',
    identity: { kind: 'commit', sha: LIVE },
    evidence: ['orders.png'],
    ...extra,
  });

const stored = async (issueId: string) =>
  rows<{ id: string; run_session_id: string | null }>(sql`
    SELECT v.id, v.run_session_id FROM criterion_verdicts v
      JOIN issue_criteria c ON c.id = v.criterion_id
     WHERE c.issue_id = ${issueId} ORDER BY v.created_at, v.id`);

describe('the same run sending the same verdict again', () => {
  it('answers 200 with the existing row and duplicate:true, and writes nothing (ISS-51 criterion 1)', async () => {
    const made = await issue();
    const session = await runHolding(made.key);
    const first = await verdict(made.id);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await verdict(made.id);
    expect(await stored(made.id)).toEqual([
      { id: (first.body as Doc).verdictId, run_session_id: session },
    ]);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ verdictId: (first.body as Doc).verdictId, duplicate: true });
    expect((first.body as Doc).duplicate).toBe(false);
  });

  it('writes a new row for a different reason, as ISS-55 criterion 3 sent after a truncated answer', async () => {
    const made = await issue();
    await runHolding(made.key);
    expect((await verdict(made.id)).status).toBe(201);
    const reworded = await verdict(made.id, { reason: 'every order is listed, checked again' });
    expect(reworded.status).toBe(201);
    expect(await stored(made.id)).toHaveLength(2);
  });

  it('writes a verdict sent again after a different one, which is no longer the latest', async () => {
    const made = await issue();
    await runHolding(made.key);
    expect((await verdict(made.id)).status).toBe(201);
    expect(
      (await verdict(made.id, { verdict: 'short', reason: 'two orders missing' })).status,
    ).toBe(201);
    expect((await verdict(made.id)).status).toBe(201);
    expect(await stored(made.id)).toHaveLength(3);
  });

  it("writes the same verdict from another run, which is that run's own judgement", async () => {
    const made = await issue();
    const one = await runHolding(made.key);
    expect((await verdict(made.id)).status).toBe(201);
    const two = await runHolding(made.key);
    expect((await verdict(made.id)).status).toBe(201);
    expect((await stored(made.id)).map((r) => r.run_session_id)).toEqual([one, two]);
  });

  it('writes one row when the resend races the first write, the second answered as its duplicate', async () => {
    const made = await issue();
    await runHolding(made.key);
    const both = await Promise.all([verdict(made.id), verdict(made.id)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(new Set(both.map((r) => (r.body as Doc).verdictId)).size).toBe(1);
    expect(await stored(made.id)).toHaveLength(1);
  });
});

describe('the probe a resend rests on is part of what it repeats', () => {
  const probe = (word: string) => ({
    kind: 'command',
    command: { argv: ['pnpm', 'test', word] },
    expect: { exitCode: 0 },
  });

  it("answers a resend without a probe as the duplicate while the run's probe is still the kept one", async () => {
    const made = await issue();
    await runHolding(made.key);
    const first = await verdict(made.id, { probe: probe('orders') });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await verdict(made.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body as Doc).verdictId).toBe((first.body as Doc).verdictId);
  });

  it('writes a resend without a probe once another run has kept a different one, since it rests on that', async () => {
    const made = await issue();
    const a = await runWithId(made.key);
    expect((await verdict(made.id, { probe: probe('orders') })).status).toBe(201);
    await runHolding(made.key);
    expect((await verdict(made.id, { probe: probe('orders-again') })).status).toBe(201);
    const resent = await verdict(made.id, { run: a.boxRunId });
    expect(resent.status, JSON.stringify(resent.body)).toBe(201);
    expect(await stored(made.id)).toHaveLength(3);
  });
});
