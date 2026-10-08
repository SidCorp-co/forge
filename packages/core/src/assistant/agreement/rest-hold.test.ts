// The REST side of REQ-30 BC-4: a record route's write on a chat credential is held, read from the
// credential, so an Agent session's shell meets it whatever it writes with. The credential, the
// session's room turn and the store are stood in for; the integration suite runs the real routes.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefusalError } from '../../lib/refusal.js';

let scope: { tokenId: string; projectIds?: string[] } | null = null;
let door: Record<string, string> | null = null;
let session: unknown = { found: true, answersRoom: false, turn: null };
let proposalStatus = 'agreed';
const held: { kind: string; form: string; call: unknown; body: Buffer | null; summary: unknown }[] =
  [];

let role = 'member';
vi.mock('../../permissions/index.js', async () => {
  const { refuser } = await import('../../lib/refusal.js');
  const refuse = refuser<'PERMISSION_FORBIDDEN'>('PERMISSION_FORBIDDEN');
  return {
    actorFor: (userId: string) => ({ userId }),
    projectResource: (projectId: string) => ({ projectId }),
    requireCan: async (_actor: unknown, permission: string) => {
      if (role === 'viewer') {
        throw refuse(
          'PERMISSION_FORBIDDEN',
          `This needs ${permission} on project p; the caller holds viewer there`,
        );
      }
    },
  };
});
vi.mock('../../credentials/pat-scope.js', () => ({ currentPatScope: () => scope }));
vi.mock('../../agent-sessions/index.js', () => ({ chatDoorOfToken: async () => door }));
vi.mock('../../conversations/index.js', () => ({ agentTurnOfSession: async () => session }));
vi.mock('./store.js', () => ({
  readProposal: async (id: string) => ({ id, status: proposalStatus }),
  recordProposal: async (p: (typeof held)[number]) => {
    held.push(p);
    return { ...p, id: 'p-1' };
  },
}));

const { admitChatRestWrite, holdChatRestWrite, refuseChatToolWrite } = await import(
  './rest-hold.js'
);
const SESSION = '5e55a0a0-0000-4000-8000-000000000001';

const app = new Hono();
app.post('/api/projects/:id/feedback', async (c) => {
  try {
    await holdChatRestWrite(c, 'feedback');
  } catch (err) {
    if (err instanceof RefusalError) return c.json({ refusals: err.refusals }, 409);
    throw err;
  }
  return c.text('written');
});

const body = { kind: 'bug', title: 'The dock loses my draft', requirement: 'REQ-30' };
const post = () =>
  app.request('/api/projects/p/feedback?x=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const codeOf = async (r: Response) =>
  ((await r.json()) as { refusals: { code: string; detail: string }[] }).refusals[0];

beforeEach(() => {
  role = 'member';
  scope = { tokenId: 't' };
  door = null;
  session = { found: true, answersRoom: false, turn: null };
  proposalStatus = 'agreed';
  held.length = 0;
});

describe("an Agent-mode session's record write waits for the person", () => {
  it('is held with its method, path and bytes, and the session is told only the press writes it', async () => {
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = {
      found: true,
      answersRoom: true,
      turn: {
        conversationId: 'room',
        question: 'the dock loses my draft',
        asker: { userId: 'u-1', viaTokenId: null },
        projectId: 'p',
        startedAt: new Date(),
      },
    };
    const r = await post();
    expect(r.status).toBe(409);
    const refusal = await codeOf(r);
    expect(refusal?.code).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(refusal?.detail).toContain('proposal p-1');
    expect(refusal?.detail).toContain('Only their press writes it');
    expect(refusal?.detail).not.toContain('/agree');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      kind: 'feedback',
      form: 'rest',
      call: {
        method: 'POST',
        path: '/api/projects/p/feedback?x=1',
        contentType: 'application/json',
      },
      summary: { title: 'Feedback (bug): The dock loses my draft', relates: ['REQ-30'] },
    });
    expect(JSON.parse(held[0]?.body?.toString('utf8') ?? '{}')).toEqual(body);
  });

  it('is refused when its session is gone, since nobody is left to agree', async () => {
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = { found: false };
    expect((await codeOf(await post()))?.code).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(held).toEqual([]);
  });

  it('passes a session that answers no room: the Agents screen and an escalation show no card', async () => {
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = { found: true, answersRoom: false, turn: null };
    expect(await (await post()).text()).toBe('written');
  });

  it('refuses a session started to answer a room it cannot name, rather than passing it', async () => {
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = { found: true, answersRoom: true, turn: null };
    const refusal = await codeOf(await post());
    expect(refusal?.code).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(refusal?.detail).toContain('cannot be read from it');
    expect(held).toEqual([]);
  });
});

describe("a write the person's role could not make is refused for that, not held", () => {
  it("refuses a viewer's session by the permission it lacks, and holds nothing", async () => {
    role = 'viewer';
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = {
      found: true,
      answersRoom: true,
      turn: {
        conversationId: 'room',
        question: 'q',
        asker: { userId: 'u-1', viaTokenId: null },
        projectId: 'p',
        startedAt: new Date(),
      },
    };
    const refusal = await codeOf(await post());
    expect(refusal?.code).toBe('PERMISSION_FORBIDDEN');
    expect(refusal?.detail).toContain('needs project.write');
    expect(held).toEqual([]);
  });

  it("refuses a viewer's assistant turn token by the permission, before saying it is held", async () => {
    role = 'viewer';
    scope = { tokenId: 't', projectIds: ['p'] };
    door = { door: 'assistant-turn', tokenId: 't' };
    expect((await codeOf(await post()))?.code).toBe('PERMISSION_FORBIDDEN');
  });
});

describe('the other credentials', () => {
  it("refuses the assistant's turn token outright: its writes are held by its own tools", async () => {
    door = { door: 'assistant-turn', tokenId: 't' };
    expect((await codeOf(await post()))?.code).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(held).toEqual([]);
  });

  it('lets the agreement token through while its proposal is being written, and never after', async () => {
    door = { door: 'agreement', tokenId: 't', proposalId: 'p-9' };
    expect(await (await post()).text()).toBe('written');
    proposalStatus = 'recorded';
    expect((await codeOf(await post()))?.code).toBe('CHAT_AGREEMENT_SPENT');
  });

  it("lets a person's own sign-in and token through untouched", async () => {
    scope = null;
    expect(await (await post()).text()).toBe('written');
    scope = { tokenId: 't' };
    door = null;
    expect(await (await post()).text()).toBe('written');
  });
});

describe('a write no route hold names meets the default: refused by name, unless a list passes it', () => {
  const admit = new Hono();
  admit.post('/api/projects/:id/:what', async (c) => {
    try {
      await admitChatRestWrite(c, {
        method: 'POST',
        route: `/api/projects/:id/${c.req.param('what')}`,
        heldAs: null,
      });
    } catch (err) {
      if (err instanceof RefusalError) return c.json({ refusals: err.refusals }, 403);
      throw err;
    }
    return c.text('written');
  });
  const send = (what: string) => admit.request(`/api/projects/p/${what}`, { method: 'POST' });

  it('refuses a room session a write route nobody named, by name', async () => {
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = {
      found: true,
      answersRoom: true,
      turn: { projectId: 'p', conversationId: 'c', asker: { userId: 'u' } },
    };
    const r = await send('labels');
    expect(r.status).toBe(403);
    const refusal = await codeOf(r);
    expect(refusal?.code).toBe('CHAT_WRITE_REFUSED');
    expect(refusal?.detail).toContain('nothing was written');
  });

  it('refuses the assistant turn token too, and passes a search sent as a POST', async () => {
    door = { door: 'assistant-turn', tokenId: 't' };
    expect((await send('labels')).status).toBe(403);
    expect(await (await send('contract-context')).text()).toBe('written');
  });

  it('passes a session answering no room, as ruled, and any credential that is no chat', async () => {
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = { found: true, answersRoom: false, turn: null };
    expect(await (await send('labels')).text()).toBe('written');
    door = null;
    expect(await (await send('labels')).text()).toBe('written');
  });

  it('refuses a room-started session whose marker is gone, never reading it as answering no room', async () => {
    // the round 3 judge cleared the marker with the session's own token and then wrote unheld
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = { found: true, answersRoom: true, turn: null };
    const r = await send('labels');
    expect(r.status).toBe(403);
    expect((await codeOf(r))?.code).toBe('CHAT_WRITE_REFUSED');
    expect(
      await refuseChatToolWrite('forge_channel', { action: 'draft' }, 'projects:write'),
    ).toContain('CHAT_WRITE_REFUSED');
  });

  it('lets an agreement token write only while its proposal is being written', async () => {
    door = { door: 'agreement', tokenId: 't', proposalId: 'p-1' };
    expect(await (await send('labels')).text()).toBe('written');
    proposalStatus = 'recorded';
    expect((await codeOf(await send('labels')))?.code).toBe('CHAT_AGREEMENT_SPENT');
  });

  it('refuses a chat credential a write tool over /mcp, and lets a read through', async () => {
    door = { door: 'box-session', tokenId: 't', sessionId: SESSION };
    session = {
      found: true,
      answersRoom: true,
      turn: { projectId: 'p', conversationId: 'c', asker: { userId: 'u' } },
    };
    expect(
      await refuseChatToolWrite('forge_channel', { action: 'draft' }, 'projects:write'),
    ).toContain('CHAT_WRITE_REFUSED');
    expect(await refuseChatToolWrite('forge_uploads', {}, 'issues:read')).toBeNull();
    door = null;
    expect(
      await refuseChatToolWrite('forge_channel', { action: 'draft' }, 'projects:write'),
    ).toBeNull();
  });
});
