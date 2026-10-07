/**
 * A release approval decided is told to the release run that asked (HOP 0.1.0, 2026-10-07: the
 * approval was recorded and the release job sat idle until a person typed into its pane). The
 * decision commits with an outbox event, and its consumer hands the decision to the live session of
 * the run's release job as a session send — the way an answer reaches the run that asked it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, patToken, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

const BETA_SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';

let projectId: string;
let ownerId: string;
const tokens: Record<'owner' | 'agent', string> = { owner: '', agent: '' };

const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await userToken(ownerId);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'release');
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    probes: 'none',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

const call = (who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(tokens[who], method, `/api/projects/${projectId}${path}`, body);

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

/** A batch cut, its release job claimed by a live session on a box, and an approval asked. */
async function releaseWaitingOnApproval(session: 'running' | 'completed' = 'running'): Promise<{
  runId: string;
  sessionId: string;
  approvalId: string;
}> {
  const issueId = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
  const cut = await call('owner', 'POST', '/release-batches', { issueIds: [issueId] });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  const runId = String(cut.body.runId);
  const sessionId = randomUUID();
  const device = await createTestDevice(ownerId);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status)
    VALUES (${sessionId}, ${projectId}, ${device}, ${runId}, 'pipeline', ${session})
  `);
  await db.execute(sql`
    UPDATE jobs SET agent_session_id = ${sessionId}
     WHERE pipeline_run_id = ${runId} AND type = 'release_batch'
  `);
  const asked = await call('agent', 'POST', `/release-batches/${runId}/approvals`, {
    evidence: { environment: 'beta', commit: BETA_SHA, reading: 'GET /api/health 200' },
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  return { runId, sessionId, approvalId: String(asked.body.id) };
}

const inboxOf = (sessionId: string) =>
  rows<{ kind: string; intent_id: string; body: string }>(sql`
    SELECT kind, intent_id, body FROM session_inbox WHERE agent_session_id = ${sessionId}
  `);

describe('a release approval decided reaches the run that asked', () => {
  it('hands an approval to the release session, once, naming the decision', async () => {
    const { runId, sessionId, approvalId } = await releaseWaitingOnApproval();
    const decided = await call(
      'owner',
      'POST',
      `/release-batches/${runId}/approvals/${approvalId}/decision`,
      { decision: 'approve' },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await settleOutbox();
    const inbox = await inboxOf(sessionId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'answer', intent_id: approvalId });
    expect(inbox[0]?.body).toContain(`Release approval ${approvalId} was APPROVED`);
    expect(inbox[0]?.body).toContain(`release run ${runId} are allowed now`);
    const page = await call('owner', 'GET', '/releases/0.1.0');
    expect((page.body.release as { verifiedBy: unknown }).verifiedBy).toMatchObject({
      kind: 'deployment',
    });
  });

  it('hands a return to the release session with its reason', async () => {
    const { runId, sessionId, approvalId } = await releaseWaitingOnApproval();
    const decided = await call(
      'owner',
      'POST',
      `/release-batches/${runId}/approvals/${approvalId}/decision`,
      { decision: 'return', reason: 'beta still serves the old build' },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await settleOutbox();
    const inbox = await inboxOf(sessionId);
    expect(inbox).toHaveLength(1);
    const [sent] = inbox;
    expect(sent?.body).toContain('was RETURNED');
    expect(sent?.body).toContain('"beta still serves the old build"');
  });

  it('tells nobody where the release job holds no live session, and the decision still stands', async () => {
    const { runId, sessionId, approvalId } = await releaseWaitingOnApproval('completed');
    const decided = await call(
      'owner',
      'POST',
      `/release-batches/${runId}/approvals/${approvalId}/decision`,
      { decision: 'approve' },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await settleOutbox();
    expect(await inboxOf(sessionId)).toEqual([]);
  });
});
