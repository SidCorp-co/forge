import { randomUUID } from 'node:crypto';
import { ReportRunSchema } from '@forge/contracts/report-queries';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { setSessionMarkerField } from '../../src/agent-sessions/index.js';
import { webConversationPorts } from '../../src/assistant/conversation-adapter.js';
import { createAgentSession } from '../../src/conversations/conversation-agent.js';
import { codeAuthored, readConversationAgentMeta } from '../../src/conversations/index.js';
import { turnTokenNameFor } from '../../src/credentials/pat-format.js';
import { AGENT_TURN_MENU, mintTurnCredential } from '../../src/credentials/turn-credential.js';
import { db } from '../../src/db/client.js';
import { agentSessions } from '../../src/db/schema.js';
import { conversations } from '../../src/db/schema-conversations.js';
import { resolveTurnAuthority } from '../../src/permissions/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// A block an Agent-mode turn posts over REST waits on that turn's reply (REQ-32 criteria 5 and 6):
// neither the room's REST read nor its socket shows it while it waits; a held reply keeps it under
// the held-reply disclosure, read by the asker alone; a reply that passes releases it into the room.
// A turn token the block cannot wait on is refused by name, and a typed figure in a block's text is
// refused at this door as at forge_show.

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;

let w: World;
let member: { id: string; token: string };
let roomId: string;
let externalId: string;
let authority: Parameters<typeof mintTurnCredential>[0]['authority'];

const turnToken = (name?: string) =>
  mintTurnCredential({
    authority,
    menu: AGENT_TURN_MENU,
    ...(name ? { name } : {}),
    ttlMs: 10 * 60_000,
  }).then((c) => c.token);

/** An Agent-mode turn answering `conversationId`, opened as a room turn opens one, and its token. */
async function agentTurn(conversationId = roomId) {
  const session = await createAgentSession({
    projectId: w.projectId,
    userId: w.userId,
    title: 'Chat: where it stands',
    progressFacts: null,
    marker: {
      venue: { adapter: 'web', externalId, shape: 'group', projectId: w.projectId },
      conversationId,
      windowId: randomUUID(),
      deliveryKey: `window:${randomUUID()}`,
      handleName: 'forge',
      question: 'where does it stand?',
      asker: { userId: w.userId, viaTokenId: null },
      door: 'web-agent-completion',
      replies: { dedup: 'd', noDevice: 'n', failed: 'f', ack: null },
    } as never,
  });
  return { sessionId: session.id, token: await turnToken(turnTokenNameFor(session.id)) };
}

const runQuery = async (token: string) => {
  const res = await api(
    token,
    'POST',
    `/api/projects/${w.projectId}/report-queries/progress-by-requirement/runs`,
    {},
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ReportRunSchema.parse(res.body);
};
const show = (token: string, block: Body, room = roomId) =>
  api(token, 'POST', `/api/conversations/${room}/blocks`, { projectId: w.projectId, block });
const room = async (token: string) =>
  (await api(token, 'GET', `/api/conversations/${roomId}`)).body;
const visualRows = async (token: string) =>
  ((await room(token)).messages as Body[]).filter((m) =>
    (m.blocks as Body[] | null)?.some((b) => b.type === 'visual'),
  );
const pushedFrames = async () => {
  const [row] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pipeline_outbox
    WHERE type = 'conversation.pushed' AND payload ->> 'conversationId' = ${roomId}`);
  return Number(row?.n ?? 0);
};
const markerOf = async (sessionId: string) => {
  const [row] = await db
    .select({ metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  const meta = readConversationAgentMeta(row?.metadata);
  if (!meta) throw new Error(`session ${sessionId} carries no conversation marker`);
  return meta;
};

/** A table block of the run, as an Agent draws it. */
const tableOf = (runId: string): Body => ({ kind: 'table', columns: ['key'], source: { runId } });

describe('a block posted on an Agent-mode turn waits on its reply', () => {
  beforeAll(async () => {
    w = await world();
    const user = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, user.id, 'member');
    member = { id: user.id, token: await userToken(user.id) };
    const opened = await api(w.token, 'POST', '/api/conversations', {
      projectId: w.projectId,
      title: 'where it stands',
      people: [member.id],
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    roomId = String(opened.body.id);
    const [row] = await db
      .select({ externalId: conversations.externalId })
      .from(conversations)
      .where(eq(conversations.id, roomId));
    externalId = String(row?.externalId);
    const resolved = await resolveTurnAuthority({
      userId: w.userId,
      projectId: w.projectId,
      viaTokenId: null,
    });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    authority = resolved.authority;
  }, 120_000);

  it('answers 202 and holds the block on the turn: neither the REST read nor the socket shows it', async () => {
    const turn = await agentTurn();
    const run = await runQuery(turn.token);
    const framesBefore = await pushedFrames();
    const res = await show(turn.token, tableOf(run.runId));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ messageId: null, held: true, kind: 'table' });

    expect(await visualRows(w.token)).toEqual([]);
    expect(await visualRows(member.token)).toEqual([]);
    expect(await pushedFrames()).toBe(framesBefore);
    const staged = (await markerOf(turn.sessionId)).staged;
    expect(staged.map((b) => [b.kind, b.runId])).toEqual([['table', run.runId]]);
  });

  it("keeps a held reply's block under the disclosure for its asker, invisible to another member", async () => {
    const turn = await agentTurn();
    const run = await runQuery(turn.token);
    await show(turn.token, tableOf(run.runId));
    const meta = await markerOf(turn.sessionId);
    // what the bridge stamps when the screen holds the session's reply
    await setSessionMarkerField(turn.sessionId, 'conversationAgent', 'held', {
      at: new Date().toISOString(),
      text: 'Here is where it stands.',
      refusals: [{ rule: 'no-empty-promise', why: 'w', quote: null, shape: 's' }],
      blocks: meta.staged,
    });
    const heldOf = async (token: string) =>
      ((await room(token)).agentTurns as Body[]).find((t) => t.sessionId === turn.sessionId)
        ?.held as Body | undefined;

    const asker = await heldOf(w.token);
    expect(((asker?.blocks ?? []) as Body[]).map((b) => (b.visual as Body).kind)).toEqual([
      'table',
    ]);
    expect(asker?.reply).toBe('Here is where it stands.');
    const other = await heldOf(member.token);
    expect(other?.reply).toBeNull();
    expect(other?.blocks).toBeNull();
    expect(await visualRows(member.token)).toEqual([]);
  });

  it("keeps the held turn's session — its transcript, its listing, its frames — to the asker alone", async () => {
    const turn = await agentTurn();
    await setSessionMarkerField(turn.sessionId, 'conversationAgent', 'held', {
      at: new Date().toISOString(),
      text: 'Here is where it stands.',
      refusals: [{ rule: 'no-empty-promise', why: 'w', quote: null, shape: 's' }],
      blocks: [],
    });
    const adminUser = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, adminUser.id, 'admin');
    const admin = await userToken(adminUser.id);
    const listed = async (token: string) =>
      (
        ((await api(token, 'GET', `/api/agent-sessions?projectId=${w.projectId}&pageSize=100`)).body
          .items ?? []) as Body[]
      ).map((s) => s.id);
    const listedForAgents = async (token: string) =>
      (
        ((await api(token, 'GET', `/api/projects/${w.projectId}/agent-sessions?limit=100`)).body
          .sessions ?? []) as Body[]
      ).map((s) => s.id);

    expect((await api(w.token, 'GET', `/api/agent-sessions/${turn.sessionId}`)).status).toBe(200);
    expect(await listed(w.token)).toContain(turn.sessionId);
    for (const token of [member.token, admin]) {
      const read = await api(token, 'GET', `/api/agent-sessions/${turn.sessionId}`);
      expect(read.status).toBe(403);
      expect(code(read)).toBe('CONVERSATION_TURN_ASKER_ONLY');
      const turns = await api(token, 'GET', `/api/agent-sessions/${turn.sessionId}/turns`);
      expect(code(turns)).toBe('CONVERSATION_TURN_ASKER_ONLY');
      const agentRead = await api(
        token,
        'GET',
        `/api/projects/${w.projectId}/agent-sessions/${turn.sessionId}`,
      );
      expect(code(agentRead)).toBe('CONVERSATION_TURN_ASKER_ONLY');
      expect(await listed(token)).not.toContain(turn.sessionId);
      expect(await listedForAgents(token)).not.toContain(turn.sessionId);
    }
    const { sessionAudienceById } = await import('../../src/agent-sessions/session-access.js');
    expect(await sessionAudienceById(turn.sessionId)).toEqual({
      projectWide: false,
      userIds: [w.userId],
    });
  });

  it('shows the block in the room once the reply releasing it is delivered', async () => {
    const turn = await agentTurn();
    const run = await runQuery(turn.token);
    await show(turn.token, tableOf(run.runId));
    const { staged } = await markerOf(turn.sessionId);
    const framesBefore = await pushedFrames();
    await webConversationPorts.deliver(
      { adapter: 'web', externalId, shape: 'group', projectId: w.projectId },
      codeAuthored('Here is where it stands.'),
      { blocks: staged },
    );
    const shown = await visualRows(member.token);
    expect(shown).toHaveLength(1);
    expect(((shown[0]?.blocks ?? []) as Body[])[0]).toMatchObject({
      type: 'visual',
      visual: { kind: 'table', source: { runId: run.runId } },
    });
    expect(await pushedFrames()).toBeGreaterThan(framesBefore);
  });

  it("refuses a block once the turn's reply was taken for delivery, by name", async () => {
    const turn = await agentTurn();
    const run = await runQuery(turn.token);
    await setSessionMarkerField(
      turn.sessionId,
      'conversationAgent',
      'claimedAt',
      new Date().toISOString(),
    );
    const res = await show(turn.token, tableOf(run.runId));
    expect([res.status, code(res)]).toEqual([409, 'REPORT_BLOCK_REPLY_SETTLED']);
  });

  it('refuses a block into a room the turn does not answer, by name', async () => {
    const turn = await agentTurn(randomUUID());
    const run = await runQuery(turn.token);
    const res = await show(turn.token, tableOf(run.runId));
    expect(code(res)).toBe('REPORT_BLOCK_OTHER_ROOM');
    expect(String(res.body.detail)).toContain(`not ${roomId}`);
  });

  it("refuses an assistant turn's token, which draws through forge_show, and a session that is gone", async () => {
    const assistant = await turnToken();
    const run = await runQuery(assistant);
    const viaRest = await show(assistant, tableOf(run.runId));
    expect(code(viaRest)).toBe('REPORT_BLOCK_TURN_DOOR');

    const orphan = await turnToken(turnTokenNameFor(randomUUID()));
    const gone = await show(orphan, tableOf(run.runId));
    expect(code(gone)).toBe('REPORT_BLOCK_TURN_UNKNOWN');
  });

  it('refuses a title stating a number its run does not hold, and holds nothing', async () => {
    const turn = await agentTurn();
    const run = await runQuery(turn.token);
    const res = await show(turn.token, {
      kind: 'table',
      title: '4217 shipped this week',
      columns: ['key'],
      source: { runId: run.runId },
    });
    expect([res.status, code(res)]).toEqual([422, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN']);
    expect(String(res.body.detail)).toContain('states the figure 4217');
    expect((await markerOf(turn.sessionId)).staged).toEqual([]);
  });
});
