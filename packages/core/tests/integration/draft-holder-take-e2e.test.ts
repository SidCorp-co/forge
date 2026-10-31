/**
 * ISS-834, issue lifecycle r26: a draft's own holder takes it straight to `in_progress`, through the
 * issue-ready checklist the open move asks, and never passes through `open`, where a pool run could
 * claim it first. Planted from agenfold FB-416: its driver held a draft, `draft → in_progress` was
 * refused ILLEGAL_TRANSITION, and the only way on was through `open`. A run that took a draft and
 * ended goes back to `draft`, never to `open` (the recovery edge r26 draws).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createReadyDraftIssue,
  createTestDevice,
  createTestIssue,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

const HOLDER = 'agenfold-driver-20261031';
const LIFECYCLE = { 'X-Forge-Lifecycle': '10' };

let projectId = '';
let adminId = '';
let box = '';
let boxPat = '';
let otherPat = '';
let seq = 0;

async function patFor(userId: string, deviceId: string, name: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  return (await mintPat({ permissions: ['*'], userId, name, deviceId, projectIds: [projectId] }))
    .plaintext;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  adminId = (await createTestUser({ verified: true })).id;
  projectId = await projectBuiltFrom(adminId, null);
  await addProjectMember(projectId, adminId, 'admin');
  box = await createTestDevice(adminId);
  await bindTestRunner(projectId, box);
  boxPat = await patFor(adminId, box, 'box-draft-holder');
  // a member agent's box, as a pool runner's is: no project.admin to move past the holder with
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  otherPat = await patFor(agent, await createTestDevice(adminId), 'box-other');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A draft whose record completes the issue-ready checklist, against its own agreed requirement. */
async function readyDraft(): Promise<{ id: string; key: string }> {
  seq += 1;
  const { id } = await createReadyDraftIssue(projectId, adminId, seq, seq);
  return { id, key: `ISS-${seq}` };
}

/** A draft that answers nothing: no requirement, no criteria. */
async function bareDraft(): Promise<{ id: string; key: string }> {
  seq += 1;
  return createTestIssue(projectId, adminId, seq, { status: 'draft', createdAt: new Date() });
}

/** The master's claim from its box: the lease the take then works under. */
async function lease(issueId: string, token = boxPat): Promise<void> {
  const res = await api(
    token,
    'PATCH',
    `/api/issues/${issueId}`,
    {
      sessionContext: {
        lease: { holder: HOLDER, renewedAt: new Date().toISOString(), minutes: 60 },
      },
    },
    LIFECYCLE,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const take = (issueId: string, token = boxPat) =>
  api(
    token,
    'POST',
    `/api/issues/${issueId}/transition`,
    { toStatus: 'in_progress', reason: 'its holder takes the draft' },
    LIFECYCLE,
  );

const codesOf = (body: unknown): string[] => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  const listed = (b.error?.refusals ?? []).map((r) => r.code);
  return listed.length > 0 ? listed : b.error?.code ? [b.error.code] : [];
};

const statusOf = async (issueId: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issueId}`))[0]?.status;

/** Every move the issue made, oldest first, and the checklist each one was judged by. */
const movesOf = (issueId: string) =>
  rows<{ from_status: string | null; to_status: string; checklist: string | null }>(sql`
    SELECT from_status, to_status, checklist FROM kernel_transitions
     WHERE entity = 'issue' AND entity_id = ${issueId} ORDER BY created_at, id`);

const jobsNaming = async (issueId: string) =>
  (
    await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM jobs WHERE issue_id = ${issueId}`)
  )[0]?.n;

describe('a draft its holder takes (ISS-834)', () => {
  it('moves straight to in_progress at triage, judged by the issue-ready checklist, never standing at open', async () => {
    const issue = await readyDraft();
    await lease(issue.id);

    const res = await take(issue.id);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issue.id)).toBe('in_progress');
    expect(await movesOf(issue.id)).toEqual([
      { from_status: 'draft', to_status: 'in_progress', checklist: 'issue_ready' },
    ]);
    const [work] = await rows<{ step: string | null }>(
      sql`SELECT step FROM issue_work_state WHERE issue_id = ${issue.id}`,
    );
    expect(work?.step).toBe('triage');
  });

  it('is refused NOT_THE_HOLDER to a box that does not hold it, and NO_HOLDER where nothing does', async () => {
    const held = await readyDraft();
    await lease(held.id);
    const other = await take(held.id, otherPat);
    expect([other.status, codesOf(other.body)], JSON.stringify(other.body)).toEqual([
      403,
      ['NOT_THE_HOLDER'],
    ]);
    expect(JSON.stringify(other.body)).toContain(HOLDER);
    expect(await statusOf(held.id)).toBe('draft');

    const free = await readyDraft();
    const none = await take(free.id);
    expect(codesOf(none.body), JSON.stringify(none.body)).toEqual(['NO_HOLDER']);
    expect(JSON.stringify(none.body)).not.toContain('`open`');
    expect(await statusOf(free.id)).toBe('draft');
  });

  it('is refused CHECKLIST_INCOMPLETE where its record leaves a gap, and stays at draft', async () => {
    const issue = await bareDraft();
    await lease(issue.id);

    const res = await take(issue.id);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codesOf(res.body)).toContain('CHECKLIST_INCOMPLETE');
    expect(await statusOf(issue.id)).toBe('draft');
    expect(await movesOf(issue.id)).toEqual([]);
  });

  it('leaves a pool nothing to claim on the way: no job names it, and it was never admissible', async () => {
    const issue = await readyDraft();
    await lease(issue.id);
    expect((await take(issue.id)).status).toBe(200);

    // the masters wake and a pool dispatches on an arrival at `open` (`ws/master-wake.ts`); the take
    // makes none, so there is no moment a pool could claim it in
    expect((await movesOf(issue.id)).map((m) => m.to_status)).not.toContain('open');
    expect(await jobsNaming(issue.id)).toBe(0);
    expect(await statusOf(issue.id)).toBe('in_progress');
  });
});

describe('a run that took a draft and ended (r26 hand-back)', () => {
  it('goes back to draft, never to open, with nothing holding it', async () => {
    const issue = await readyDraft();
    const opened = await api(
      boxPat,
      'POST',
      '/api/devices/me/run-sessions',
      { projectId, runId: randomUUID(), issueKeys: [issue.key], name: issue.key },
      LIFECYCLE,
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const sessionId = String((opened.body as Doc).sessionId);
    const taken = await take(issue.id);
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);

    const closed = await api(
      boxPat,
      'POST',
      `/api/devices/me/run-sessions/${sessionId}/close`,
      { outcome: 'ended' },
      LIFECYCLE,
    );

    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await statusOf(issue.id)).toBe('draft');
    expect((await movesOf(issue.id)).map((m) => `${m.from_status}→${m.to_status}`)).toEqual([
      'draft→in_progress',
      'in_progress→draft',
    ]);
  });
});
