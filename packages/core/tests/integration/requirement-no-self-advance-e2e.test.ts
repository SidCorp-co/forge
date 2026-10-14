/**
 * Nothing moves a requirement by itself (owner's ruling on ISS-456, 2026-10-14: REQ-45 BC-7 covers
 * requirements too). A draft whose ready checklist is complete stays a draft through every cluster
 * timer core runs, with no person-gate switch on; the complete checklist only lets a person or an
 * agent make each move through its own door. Against real Postgres.
 *
 * @direct-test-of packages/core/src/timer-registry.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { coreTimers } from '../../src/timer-registry.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  truncateAll,
} from '../helpers/factories.js';

type Res = { status: number; body: Record<string, unknown> };

let projectId: string;
let ownerId: string;
let owner: string;
let agent: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  owner = await userToken(ownerId);
  const bot = await createTestUser({ kind: 'agent' });
  await addProjectMember(projectId, bot.id, 'member');
  agent = await patToken(bot.id, [projectId]);
});

const on = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body) as Promise<Res>;

/** `REQ-n` as its author left it, with every ready answer in: a draft holding a draft revision 1. */
async function readyDraft(): Promise<{ key: string; seq: number }> {
  const made = await on(owner, 'POST', '/requirements', {
    title: 'Reminders reach the nurse',
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A patient can opt out' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const key = String(made.body.key);
  const seq = Number(key.slice(4));
  await makeAgreeReady(projectId, seq, ownerId);
  return { key, seq };
}

async function standingOf(seq: number): Promise<{ status: string; revision: string }> {
  const [row] = await rows<{ status: string; revision: string }>(sql`
    SELECT r.status, v.state AS revision
      FROM requirements r JOIN requirement_revisions v ON v.requirement_id = r.id AND v.revision = 1
     WHERE r.project_id = ${projectId} AND r.req_seq = ${seq}
  `);
  if (!row) throw new Error(`REQ-${seq} has no revision 1`);
  return row;
}

describe('a requirement whose ready checklist is complete', () => {
  it('stays a draft through every cluster timer core runs, with no person-gate switch on', async () => {
    const { seq } = await readyDraft();
    const cluster = coreTimers().filter((t) => t.kind === 'cluster');
    expect(cluster.length).toBeGreaterThan(0);

    // what a timer does to anything else is not this test's question, so its failure is its own
    for (const timer of cluster) await Promise.resolve(timer.run()).catch(() => undefined);

    expect(await standingOf(seq)).toEqual({ status: 'draft', revision: 'draft' });
  }, 120_000);

  it('moves when an agent makes each move through its door: propose, accept, agree', async () => {
    const { key, seq } = await readyDraft();

    for (const path of [
      `/requirements/${key}/revisions/1/propose`,
      `/requirements/${key}/revisions/1/accept`,
    ]) {
      const r = await on(agent, 'POST', path, {});
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
    }
    const agreed = await on(agent, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed by the agent for this test.',
    });

    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200);
    expect(await standingOf(seq)).toEqual({ status: 'agreed', revision: 'current' });
  });
});
