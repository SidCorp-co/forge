/**
 * REQ-72 BC-4 and BC-5: whoever holds a permission may act, person or agent alike, and an act refused
 * is refused the same way at every door. One act is planted — drafting a requirement, which takes
 * project.write — and a viewer asks for it at the four doors a person or an agent reaches Forge
 * through: the web (a signed-in session), the API (a personal access token), the agent tools (the
 * forge_requirements tool over /mcp) and chat (an Agent-mode session answering a room, whose writes
 * are held for a card). Each answers the same code and the same refusal envelope. An agent holding
 * the same role is refused identically, and a person and an agent holding project.write both draft.
 *
 * @direct-test-of packages/core/src/permissions/can.ts
 * @direct-test-of packages/core/src/assistant/agreement/roles.ts
 * @direct-test-of packages/core/src/mcp/requirements-tool.ts
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { api } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

type Who = 'owner' | 'web' | 'api' | 'chat' | 'agent' | 'memberPerson' | 'memberAgent';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let tokens: Record<Who, string>;
let projectId = '';

const DRAFT = {
  title: 'A refused draft names who may write it',
  reason: 'The doors must agree.',
  criteria: [{ body: 'Every door refuses the same way.' }],
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { AGENT_TURN_MENU } = await import('../../src/credentials/turn-credential.js');
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { mintSessionCredential } = await import('../../src/agent-sessions/index.js');
  const { createAgentSession } = await import('../../src/conversations/conversation-agent.js');
  const { agentSessions } = await import('../../src/db/schema.js');
  const { db } = await import('../../src/db/client.js');

  const owner = (await createTestUser({ verified: true })).id;
  const viewer = (await createTestUser({ verified: true })).id;
  const viewerAgent = (await createTestUser({ kind: 'agent' })).id;
  const member = (await createTestUser({ verified: true })).id;
  const memberAgent = (await createTestUser({ kind: 'agent' })).id;
  const project = await createTestProject(owner);
  projectId = project.id;
  // a project's agents are its handles, so each carries one on its org membership, as a minted one does
  for (const [agent, handle] of [
    [viewerAgent, 'doors-viewer'],
    [memberAgent, 'doors-member'],
  ] as const) {
    await db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role, handle)
      VALUES (${project.orgId}, ${agent}, 'member', ${handle})
    `);
  }
  await addProjectMember(projectId, owner, 'owner');
  await addProjectMember(projectId, viewer, 'viewer');
  await addProjectMember(projectId, viewerAgent, 'viewer');
  await addProjectMember(projectId, member, 'member');
  await addProjectMember(projectId, memberAgent, 'member');
  const pat = async (userId: string) =>
    (
      await mintPat({
        permissions: ['*'],
        userId,
        name: `doors-${userId}`,
        projectIds: [projectId],
      })
    ).plaintext;

  const session = await signUserToken(owner);
  const opened = await requester(app, { owner: session })('owner', 'POST', '/api/conversations', {
    projectId,
    title: 'the doors',
    people: [viewer],
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const roomId = String(opened.json.id);

  // the viewer's Agent-mode session answering the room, opened as a room turn opens one
  const resolved = await resolveTurnAuthority({ userId: viewer, projectId, viaTokenId: null });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const deviceId = await createTestDevice(viewer);
  const turn = await createAgentSession({
    projectId,
    userId: viewer,
    title: 'Agent: the doors',
    progressFacts: null,
    marker: {
      venue: { adapter: 'web', externalId: roomId, projectId },
      conversationId: roomId,
      windowId: randomUUID(),
      deliveryKey: `window:${randomUUID()}`,
      question: 'Draft it, please.',
      asker: { userId: viewer, viaTokenId: null },
    } as never,
  });
  await db.update(agentSessions).set({ deviceId }).where(eq(agentSessions.id, turn.id));

  tokens = {
    owner: session,
    web: await signUserToken(viewer),
    api: await pat(viewer),
    chat: await mintSessionCredential({
      sessionId: turn.id,
      deviceId,
      value: { authority: resolved.authority, menu: AGENT_TURN_MENU },
    }),
    agent: await pat(viewerAgent),
    memberPerson: await pat(member),
    memberAgent: await pat(memberAgent),
  };
  say = requester(app, tokens) as typeof say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const at = `/api/projects/${'{id}'}/requirements`;
const draftAt = () => at.replace('{id}', projectId);

/** The forge_requirements tool's answer, read as the JSON body its text carries. */
async function tool(who: Who, args: Doc): Promise<{ isError: boolean; body: Doc }> {
  const r = await api(
    tokens[who],
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_requirements', arguments: { projectId, ...args } },
    },
    { accept: 'application/json, text/event-stream' },
  );
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  const result = r.body.result as { content: { text?: string }[]; isError?: boolean };
  const text = result.content.map((c) => c.text ?? '').join('\n');
  return { isError: result.isError === true, body: JSON.parse(text) as Doc };
}

/** The refusal envelope a door answered, with its free-text detail set aside to compare the rest. */
const envelopeOf = (body: Doc) => {
  const error = body.error as { code: string; refusals: Doc[] };
  return {
    code: error.code,
    refusals: error.refusals.map(({ detail, ...rest }) => ({ ...rest, detail: typeof detail })),
  };
};

const drafts = async () =>
  Number(
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM requirements WHERE project_id = ${projectId}`,
      )
    )[0]?.n,
  );

describe('REQ-72 BC-5: one act refused at every door answers the same code and envelope', () => {
  it('refuses a viewer drafting a requirement identically on web, API, agent tools and chat', async () => {
    const web = await say('web', 'POST', draftAt(), DRAFT);
    const rest = await say('api', 'POST', draftAt(), DRAFT);
    const chat = await say('chat', 'POST', draftAt(), DRAFT);
    const mcp = await tool('api', { action: 'create', ...DRAFT });

    for (const [door, r] of [
      ['web', web],
      ['api', rest],
      ['chat', chat],
    ] as const) {
      expect(r.status, `${door}: ${JSON.stringify(r.json).slice(0, 300)}`).toBe(403);
    }
    expect(mcp.isError).toBe(true);

    const expected = envelopeOf(rest.json);
    expect(expected).toMatchObject({
      code: 'PERMISSION_FORBIDDEN',
      refusals: [{ code: 'PERMISSION_FORBIDDEN', permission: 'project.write' }],
    });
    expect({
      web: envelopeOf(web.json),
      chat: envelopeOf(chat.json),
      mcp: envelopeOf(mcp.body),
    }).toEqual({ web: expected, chat: expected, mcp: expected });
    expect(await drafts()).toBe(0);
  });
});

describe('REQ-72 BC-4: a permission decides, never whether a person or an agent holds it', () => {
  it('refuses an agent holding the viewer role exactly as it refuses the viewer, at the API and the tools', async () => {
    const person = envelopeOf((await say('api', 'POST', draftAt(), DRAFT)).json);
    const rest = await say('agent', 'POST', draftAt(), DRAFT);
    expect(rest.status).toBe(403);
    expect(envelopeOf(rest.json)).toEqual(person);
    expect(envelopeOf((await tool('agent', { action: 'create', ...DRAFT })).body)).toEqual(person);
  });

  it('lets a person and an agent holding project.write draft the same requirement', async () => {
    for (const who of ['memberPerson', 'memberAgent'] as const) {
      const r = await say(who, 'POST', draftAt(), { ...DRAFT, title: `${DRAFT.title} (${who})` });
      expect(r.status, `${who}: ${JSON.stringify(r.json).slice(0, 300)}`).toBe(201);
    }
    expect(await drafts()).toBe(2);
  });
});
