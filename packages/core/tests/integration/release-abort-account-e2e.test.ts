/**
 * ISS-1095: a cancelled release run's state and its release's attempts read the abort it recorded.
 * sidpeak's 0.24.0 and 0.25.0 (2026-11-07) were aborted by their own release job after the
 * production deploy waited on a person's confirm: `metadata.abort` held the reason, the actor, the
 * blocker (a person owes `confirm-prod-deploy`) and the carried tag, and `/state` answered
 * `runStatus: cancelled, failure: null` with none of it, so three readers took it for an unexplained
 * cancel. Planted here through the app's own doors: an agent's abort with its whole account, read on
 * `/state` and on `releases/:version`; and a cancel with no abort, which reads as unexplained by name.
 *
 * @direct-test-of packages/core/src/release-batch/abort-account.ts
 * @direct-test-of packages/core/src/release-batch/abort-stamp.ts
 * @direct-test-of packages/core/src/release-batch/state.ts
 * @direct-test-of packages/core/src/release-batch/release-cuts.ts
 * @direct-test-of packages/core/src/release-batch/version-store.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeRunIfOneShot } from '../../src/pipeline/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

const REASON =
  'The production deploy waits on a person: integrations/coolify/deploy answered pendingHumanConfirm (awaiting-prod-confirm).';
const BLOCKER = { owes: 'human', waitingFor: 'confirm-prod-deploy' } as const;
const TAG = { kind: 'tag', name: 'v0.24.0' } as const;
const COMMIT = { kind: 'commit', name: '7d070c60185533ac6c368d4dfc6ee0e54cf2c1e6' } as const;
const HANDLE = 'sidpeak-release';

describe('an aborted release run reads the account its abort recorded', () => {
  let projectId: string;
  let ownerId: string;
  let token: string;
  let agentId: string;
  let agentToken: string;
  const fx = releaseWorld(() => ({ projectId, ownerId }));

  beforeEach(async () => {
    await truncateAll();
    ownerId = (await createTestUser({ verified: true })).id;
    projectId = (await createTestProject(ownerId)).id;
    token = await userToken(ownerId);
    agentId = (await createTestUser({ kind: 'agent' })).id;
    await db.execute(sql`UPDATE users SET display_name = ${HANDLE} WHERE id = ${agentId}`);
    await addProjectMember(projectId, agentId, 'admin');
    agentToken = await userToken(agentId);
    await fx.seedReleaseRunner();
    const bindingId = await fx.declareProduction({}, 'none');
    await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
  });

  async function cut(): Promise<{ runId: string; version: string }> {
    const issueIds = [await fx.insertIssue()];
    const r = await api(token, 'POST', `/api/projects/${projectId}/release-batches`, { issueIds });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { runId: String(r.body.runId), version: String(r.body.version) };
  }

  const state = async (runId: string) => {
    const r = await api(token, 'GET', `/api/projects/${projectId}/release-batches/${runId}/state`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { runStatus: string; abort?: unknown };
  };

  const cutOf = async (version: string, runId: string) => {
    const r = await api(token, 'GET', `/api/projects/${projectId}/releases/${version}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cuts = (r.body.release as { cuts: Array<{ runId: string; abort?: unknown }> }).cuts;
    return cuts.find((c) => c.runId === runId);
  };

  it('names the reason, the agent by its handle, the blocker, the push and the carried tag on both reads', async () => {
    const { runId, version } = await cut();
    const aborted = await api(
      agentToken,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/abort`,
      { reason: REASON, blocker: BLOCKER, pushed: true, carried: [TAG, COMMIT] },
    );
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);

    const account = {
      recorded: true,
      reason: REASON,
      by: { id: agentId, name: HANDLE, kind: 'agent' },
      blocker: BLOCKER,
      pushed: true,
      roster: 'released',
      carried: [TAG, COMMIT],
    };

    const read = await state(runId);
    expect(read.runStatus).toBe('cancelled');
    expect.soft(read.abort, '/state names the abort it recorded').toMatchObject(account);

    const own = await cutOf(version, runId);
    expect(own, `releases/${version} lists the aborted cut as an attempt`).toBeDefined();
    expect.soft(own?.abort, 'the attempt names the abort it recorded').toMatchObject(account);
    expect(own?.abort, 'the attempt carries the same account as /state').toEqual(read.abort);
  });

  it('a cancel with no abort record reads as unexplained, by name', async () => {
    const { runId, version } = await cut();
    await closeRunIfOneShot(runId, 'cancelled');

    const read = await state(runId);
    expect(read.abort).toMatchObject({ recorded: false });
    expect((read.abort as { says: string }).says).toMatch(/no abort was recorded/i);

    const own = await cutOf(version, runId);
    expect(own?.abort).toEqual(read.abort);
  });

  it('a run nobody aborted or cancelled reads no abort at all', async () => {
    const { runId } = await cut();
    expect((await state(runId)).abort).toBeNull();
  });
});
