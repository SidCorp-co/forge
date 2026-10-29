/**
 * REQ-47 r2 BC-12 and BC-13 (ISS-749): a reporter replies once to each answer, with evidence, and the
 * reply sends the item back to its triager as a reopen does; an answer to a reopened item names the
 * reopen or reply it answers, and one naming none, or one that no longer stands, is refused by name.
 *
 * Planted from forge-dev on 2026-10-29: FB-333's reporter reopened with a reproduction at 04:45Z, an
 * answer written against the item as it read before landed 80 s later without addressing it, and
 * the reporter reopened again at 05:32Z. The door had no reply, and the triage took an answer that
 * named nothing it answered.
 *
 * @direct-test-of packages/core/src/feedback/reply.ts
 * @direct-test-of packages/core/src/feedback/reply-rules.ts
 * @direct-test-of packages/core/src/forge-door/service.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { owedTriages } from '../../src/feedback/owed-triage.js';
import { api, type Body } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

let w: World;
let agent = '';
let agentPat = '';
let otherPat = '';

interface Refused {
  code: string;
  path: string;
  detail: string;
}
interface Decision {
  id: string;
  decision: string;
  route: string | null;
  reason: string | null;
  inReplyTo: string | null;
}

const at = (path: string) => `/api/projects/${w.projectId}${path}`;
const refusalOf = (body: Body): Refused | undefined =>
  ((body.error as { refusals?: Refused[] })?.refusals ?? [])[0];

async function detail(key: string): Promise<Body> {
  const res = await api(w.token, 'GET', at(`/feedback/${key}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.feedback as Body;
}
const decisionsOf = async (key: string) => (await detail(key)).decisions as Decision[];

/** An item about Forge the agent files through the Forge door, as its own account. */
async function filed(title: string): Promise<string> {
  const res = await api(agentPat, 'POST', '/api/forge/feedback', {
    kind: 'question',
    title,
    whereSeen: 'route GET /api/forge/feedback/FB-1',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.feedback as Body).key as string;
}

const triage = (key: string, body: Record<string, unknown>) =>
  api(w.token, 'POST', at(`/feedback/${key}/triage`), { answers: TRIAGE_ANSWERS, ...body });

async function answered(title: string, answer = 'It works as designed.'): Promise<string> {
  const key = await filed(title);
  const res = await triage(key, { route: 'answer', answer });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return key;
}

const reply = (key: string, body: Record<string, unknown>, token = agentPat) =>
  api(token, 'POST', `/api/forge/feedback/${key}/reply`, body);

async function callTool(token: string, args: Record<string, unknown>) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_feedback', arguments: args },
    },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0]?.text ?? '{}') as Body,
  };
}

/** The item's status and decision count, which a refusal leaves exactly as they were. */
async function unchanged(key: string): Promise<{ status: unknown; decisions: number }> {
  const d = await detail(key);
  return { status: d.status, decisions: (d.decisions as Decision[]).length };
}

beforeAll(async () => {
  testEnv();
  w = await world();
  agent = (await createTestUser({ kind: 'agent' })).id;
  const other = (await createTestUser({ kind: 'agent' })).id;
  // the reporters work in a project of their own and are no members of the home project (REQ-47 BC-3)
  const client = (await createTestProject(w.userId)).id;
  for (const id of [agent, other]) await addProjectMember(client, id);
  const pat = async (userId: string) =>
    (
      await mintPat({
        permissions: ['*'],
        userId,
        name: 'box',
        projectIds: [client],
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;
  agentPat = await pat(agent);
  otherPat = await pat(other);
  await db.execute(sql`
    INSERT INTO instance_settings (id, forge_home_project_id) VALUES (1, ${w.projectId})
    ON CONFLICT (id) DO UPDATE SET forge_home_project_id = ${w.projectId}
  `);
}, 120_000);

describe('the reporter replies once to each answer (BC-12)', () => {
  it('sends the item back to its triager as a reopen does, kept as a replied decision', async () => {
    const fb = await answered('Where does the answer show?');
    expect((await detail(fb)).phase).toBe('resolved');

    const res = await reply(fb, {
      evidence: 'GET /api/forge/feedback/FB-1 still shows no answer.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ key: fb, phase: 'reopened' });

    const d = await detail(fb);
    expect(d.status).toBe('reopened');
    const last = (d.decisions as Decision[]).at(-1);
    expect(last).toMatchObject({
      decision: 'replied',
      reason: 'GET /api/forge/feedback/FB-1 still shows no answer.',
      inReplyTo: null,
    });
    expect(last?.id).toMatch(/^[0-9a-f-]{36}$/);
    const owed = await owedTriages(w.projectId);
    expect(owed.find((o) => o.key === fb)).toMatchObject({ status: 'reopened' });
  });

  it('replies over MCP with forge_feedback reply, as REST does', async () => {
    const fb = await answered('Does MCP reply too?');
    const out = await callTool(agentPat, {
      action: 'reply',
      feedback: fb,
      evidence: 'Read it over MCP; the answer does not say which door.',
    });
    expect(out.isError, JSON.stringify(out.body)).toBe(false);
    expect(out.body).toMatchObject({ key: fb, phase: 'reopened' });
    expect((await decisionsOf(fb)).at(-1)?.decision).toBe('replied');
  });

  it('refuses a second reply to the same answer, writing nothing', async () => {
    const fb = await answered('A second reply?');
    expect((await reply(fb, { evidence: 'First reply.' })).status).toBe(200);
    const before = await unchanged(fb);
    const again = await reply(fb, { evidence: 'Second reply.' });
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(400);
    expect(refusalOf(again.body)).toMatchObject({
      code: 'FEEDBACK_REPLY_SPENT',
      path: '/feedback',
    });
    expect(refusalOf(again.body)?.detail).toContain('"First reply."');
    expect(await unchanged(fb)).toEqual(before);
  });

  it('takes a reply again once the triager answered the reply', async () => {
    const fb = await answered('Answered twice?');
    expect((await reply(fb, { evidence: 'First reply.' })).status).toBe(200);
    const standing = (await decisionsOf(fb)).at(-1)?.id;
    const second = await triage(fb, {
      route: 'answer',
      answer: 'Second answer.',
      inReplyTo: standing,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const res = await reply(fb, { evidence: 'Reply to the second answer.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses a reply without evidence, writing nothing', async () => {
    const fb = await answered('A bare reply?');
    const before = await unchanged(fb);
    for (const body of [{}, { evidence: '   ' }]) {
      const res = await reply(fb, body);
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(refusalOf(res.body)).toMatchObject({
        code: 'FEEDBACK_EVIDENCE_REQUIRED',
        path: '/evidence',
      });
    }
    expect(await unchanged(fb)).toEqual(before);
  });

  it('refuses a reply on an item that stands on no answer, writing nothing', async () => {
    const untriaged = await filed('Never answered');
    const routed = await filed('Routed to work');
    const toWork = await triage(routed, { route: 'issue' });
    expect(toWork.status, JSON.stringify(toWork.body)).toBe(200);
    for (const fb of [untriaged, routed]) {
      const before = await unchanged(fb);
      const res = await reply(fb, { evidence: 'Is there an answer?' });
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(refusalOf(res.body)?.code).toBe('FEEDBACK_REPLY_NO_ANSWER');
      expect(await unchanged(fb)).toEqual(before);
    }
  });

  it("refuses a reply to another account's item, writing nothing", async () => {
    const fb = await answered('Whose reply?');
    const before = await unchanged(fb);
    // a member of the home project reads the item, and is still not its reporter
    const member = await reply(fb, { evidence: 'Not mine to reply to.' }, w.token);
    expect(member.status, JSON.stringify(member.body)).toBe(403);
    expect(refusalOf(member.body)?.code).toBe('FORGE_FEEDBACK_NOT_YOURS');
    // another reporter reads nothing of it
    const stranger = await reply(fb, { evidence: 'Not mine to reply to.' }, otherPat);
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(404);
    expect(refusalOf(stranger.body)?.code).toBe('FORGE_FEEDBACK_NOT_FOUND');
    expect(await unchanged(fb)).toEqual(before);
  });
});

describe('an answer to a reopened item names what it answers (BC-13)', () => {
  /** FB-333: the reporter reopens an answered item with its reproduction. */
  async function reopened(title: string): Promise<{ fb: string; reopen: string }> {
    const fb = await answered(title);
    const res = await api(agentPat, 'POST', `/api/forge/feedback/${fb}/reopen`, {
      evidence: 'Reproduced: the answer is not readable at GET /api/forge/feedback.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const reopen = (await decisionsOf(fb)).at(-1);
    expect(reopen?.decision).toBe('reopened');
    return { fb, reopen: reopen?.id ?? '' };
  }

  it('refuses an answer naming nothing, quoting the reopen and naming its id', async () => {
    const { fb, reopen } = await reopened('Answered past the reopen');
    const before = await unchanged(fb);
    const res = await triage(fb, { route: 'answer', answer: 'Written against the earlier state.' });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    const r = refusalOf(res.body);
    expect(r).toMatchObject({ code: 'FEEDBACK_ANSWER_UNADDRESSED', path: '/inReplyTo' });
    expect(r?.detail).toContain(reopen);
    expect(r?.detail).toContain('Reproduced: the answer is not readable');
    expect(await unchanged(fb)).toEqual(before);
  });

  it('refuses an answer naming a reopen that no longer stands, or none at all', async () => {
    const fb = await answered('Answered twice over');
    expect((await reply(fb, { evidence: 'First reply.' })).status).toBe(200);
    const first = (await decisionsOf(fb)).at(-1)?.id ?? '';
    expect(
      (await triage(fb, { route: 'answer', answer: 'Answer one.', inReplyTo: first })).status,
    ).toBe(200);
    expect((await reply(fb, { evidence: 'Second reply.' })).status).toBe(200);
    const before = await unchanged(fb);
    for (const stale of [first, randomUUID()]) {
      const res = await triage(fb, { route: 'answer', answer: 'Answer two.', inReplyTo: stale });
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(refusalOf(res.body)).toMatchObject({
        code: 'FEEDBACK_ANSWER_STALE',
        path: '/inReplyTo',
      });
      expect(refusalOf(res.body)?.detail).toContain('"Second reply."');
    }
    expect(await unchanged(fb)).toEqual(before);
  });

  it('refuses inReplyTo on an item that stands on no reopen or reply', async () => {
    const fb = await filed('Never reopened');
    const before = await unchanged(fb);
    const res = await triage(fb, {
      route: 'answer',
      answer: 'An answer.',
      inReplyTo: randomUUID(),
    });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(refusalOf(res.body)?.code).toBe('FEEDBACK_ANSWER_STALE');
    expect(await unchanged(fb)).toEqual(before);
  });

  it('refuses inReplyTo on a route that is no answer', async () => {
    const { fb, reopen } = await reopened('Reopened, then routed to work');
    const res = await triage(fb, { route: 'issue', inReplyTo: reopen });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(refusalOf(res.body)).toMatchObject({
      code: 'FEEDBACK_ROUTE_TARGET_MISMATCH',
      path: '/inReplyTo',
    });
  });

  it('takes an answer naming the standing reopen, and its decision keeps it', async () => {
    const { fb, reopen } = await reopened('Answered in reply');
    const res = await triage(fb, {
      route: 'answer',
      answer: 'Read it at the item now.',
      inReplyTo: reopen,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = await detail(fb);
    expect(d.phase).toBe('resolved');
    expect((d.decisions as Decision[]).at(-1)).toMatchObject({
      decision: 'triaged',
      route: 'answer',
      inReplyTo: reopen,
    });
  });

  it('takes an answer to an item never reopened without inReplyTo', async () => {
    const fb = await answered('First answer needs no reply id');
    expect((await decisionsOf(fb)).at(-1)).toMatchObject({ route: 'answer', inReplyTo: null });
  });
});
