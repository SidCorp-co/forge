import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-00000000000a';
const CALLER = '00000000-0000-4000-8000-00000000000b';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TURN_ID = '00000000-0000-4000-8000-000000000002';
const PROJECT_ID = '00000000-0000-4000-8000-000000000003';

const state = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  role: 'member' as 'member' | 'admin',
  transcript: [] as unknown[],
  turn: null as { id: string; turnIndex: number; role: string } | null,
  transitions: [] as Array<Record<string, unknown>>,
  truncatedTo: [] as number[],
}));

const insertChain = vi.hoisted(() => () => ({
  values: (v: Record<string, unknown>) => ({
    returning: async () => [{ id: 'fork-1', ...v }],
  }),
}));
vi.mock('../db/client.js', () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({ insert: insertChain }) },
}));

vi.mock('./session-access.js', async (orig) => {
  const actual = await orig<typeof import('./session-access.js')>();
  const facts = () => ({ projectId: PROJECT_ID, role: state.role, grants: [] });
  return {
    ...actual,
    ensureSessionMember: vi.fn(async () => ({ session: state.session, access: facts() })),
    ensureSessionOwnerOrAdmin: vi.fn(async () => ({ session: state.session, access: facts() })),
  };
});

const readTranscript = vi.hoisted(() => vi.fn(async () => state.transcript));
vi.mock('./turns-helpers.js', async (orig) => ({
  ...(await orig<typeof import('./turns-helpers.js')>()),
  readTranscript,
  findTurnInSession: vi.fn(async () => state.turn),
  writeTranscript: vi.fn(async () => ({ appended: [], truncatedFromTurnIndex: null })),
  truncateTranscript: vi.fn(async (_tx: unknown, _id: string, keep: number) => {
    state.truncatedTo.push(keep);
  }),
}));

vi.mock('./session-transition.js', () => ({
  transitionSessions: vi.fn(async (_exec: unknown, args: Record<string, unknown>) => {
    state.transitions.push(args);
    await (args.afterWrite as (tx: unknown) => Promise<void>)({});
    return { rows: [{ ...state.session, ...(args.set as object), status: 'queued' }] };
  }),
}));
vi.mock('./session-events.js', () => ({ recordReportedTranscript: vi.fn(async () => {}) }));

const broadcastTurnTruncated = vi.hoisted(() => vi.fn());
vi.mock('./broadcast.js', () => ({
  broadcastSession: vi.fn(),
  broadcastTurnAppended: vi.fn(),
  broadcastTurnEdited: vi.fn(),
  broadcastTurnTruncated,
}));

const dispatchInteractiveTurn = vi.hoisted(() =>
  vi.fn(async (a: { session: Record<string, unknown> }) => ({ ...a.session, status: 'running' })),
);
vi.mock('./interactive-credential.js', () => ({
  resolveInteractiveClient: vi.fn(async () => ({ deviceId: 'd-1' })),
  authorizeInteractiveTurn: vi.fn(async () => ({})),
  dispatchInteractiveTurn,
}));
vi.mock('./chat-turn.js', () => ({ createChatSessionRow: vi.fn() }));
vi.mock('./read.js', () => ({ projectHandle: vi.fn(async () => ({ id: PROJECT_ID })) }));
vi.mock('./session-activity.js', () => ({ recordSessionCreatedActivity: vi.fn(async () => {}) }));
vi.mock('../pipeline/index.js', () => ({ openOneShotRun: vi.fn(async () => ({ id: 'run-1' })) }));

const { agentSessionTurnsRoutes } = await import('./turns-routes.js');
const { errorHandler } = await import('../middleware/error.js');

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, CALLER as never);
  c.set('agency' as never, 'human' as never);
  await next();
});
app.route('/', agentSessionTurnsRoutes);
app.onError(errorHandler as never);

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function sessionOf(over: Record<string, unknown>) {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    userId: OWNER,
    deviceId: 'd-1',
    title: 'Mine',
    status: 'idle',
    repoPath: '/r',
    claudeSessionId: 'claude-old',
    updatedAt: new Date(0),
    metadata: {},
    ...over,
  };
}

const user = (content: string) => ({ type: 'user', content });
const system = () => ({ type: 'system', content: 'Session started' });
const assistant = (content: string) => ({ type: 'assistant', content });
const toolResult = () => ({ type: 'tool_result', toolOutput: 'ok' });

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'member';
  state.transitions.length = 0;
  state.truncatedTo.length = 0;
});

describe('POST /:id/fork reads a private agent chat only as its owner may', () => {
  beforeEach(() => {
    state.transcript = [user('secret plan'), assistant('the secret answer')];
    state.turn = { id: TURN_ID, turnIndex: 1, role: 'assistant' };
  });

  it("refuses a project writer forking another person's agent chat, and answers no transcript", async () => {
    state.session = sessionOf({ metadata: { type: 'agent' } });
    const res = await post(`/${SESSION_ID}/fork`, { fromTurnId: TURN_ID });
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).toContain('AGENT_CHAT_OWNER_FORBIDDEN');
    expect(text).not.toContain('secret');
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it("lets the owner fork their own agent chat, and the fork is the caller's", async () => {
    state.session = sessionOf({ userId: CALLER, metadata: { type: 'agent' } });
    const res = await post(`/${SESSION_ID}/fork`, { fromTurnId: TURN_ID });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { userId: string; messages: unknown[] };
    expect(body.userId).toBe(CALLER);
    expect(body.messages).toHaveLength(2);
  });

  it("lets a project.admin fork another person's agent chat, owned by the admin", async () => {
    state.role = 'admin';
    state.session = sessionOf({ metadata: { type: 'agent' } });
    const res = await post(`/${SESSION_ID}/fork`, { fromTurnId: TURN_ID });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { userId: string }).userId).toBe(CALLER);
  });

  it('creates a fork of a shared (non-agent) session as the caller, not the parent owner', async () => {
    state.session = sessionOf({ metadata: {} });
    const res = await post(`/${SESSION_ID}/fork`, { fromTurnId: TURN_ID });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { userId: string }).userId).toBe(CALLER);
  });
});

describe('POST /:id/turns/:turnId/regenerate replays from the prompt, once, on a cold start', () => {
  const regenerate = () => post(`/${SESSION_ID}/turns/${TURN_ID}/regenerate`);

  it('cuts at the prompt when system and tool_result entries sit between it and the reply', async () => {
    state.session = sessionOf({ userId: CALLER });
    state.transcript = [
      user('fix X'),
      system(),
      assistant('call'),
      toolResult(),
      assistant('done'),
    ];
    state.turn = { id: TURN_ID, turnIndex: 4, role: 'assistant' };

    const res = await regenerate();
    expect(res.status).toBe(200);
    expect(state.truncatedTo).toEqual([0]);
    expect(broadcastTurnTruncated).toHaveBeenCalledWith(expect.anything(), 0);
    expect(dispatchInteractiveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fix X' }),
    );
  });

  it('keeps earlier exchanges and stores the regenerated prompt exactly once', async () => {
    state.session = sessionOf({ userId: CALLER });
    state.transcript = [
      user('a'),
      system(),
      assistant('A'),
      user('b'),
      system(),
      assistant('call'),
      toolResult(),
      assistant('B'),
    ];
    state.turn = { id: TURN_ID, turnIndex: 5, role: 'assistant' };

    await regenerate();
    expect(state.truncatedTo).toEqual([3]);
    expect(broadcastTurnTruncated).toHaveBeenCalledWith(expect.anything(), 3);
    const kept = state.transcript.slice(0, state.truncatedTo[0]);
    const stored = [...kept, user('b')];
    expect(stored.filter((m) => (m as { content?: string }).content === 'b')).toHaveLength(1);
  });

  it('clears the resumed Claude session so the redo cold-starts on the stored history', async () => {
    state.session = sessionOf({ userId: CALLER });
    state.transcript = [user('fix X'), system(), assistant('done')];
    state.turn = { id: TURN_ID, turnIndex: 2, role: 'assistant' };

    await regenerate();
    expect(state.transitions[0]?.set).toMatchObject({ claudeSessionId: null });
    const dispatched = dispatchInteractiveTurn.mock.calls[0]?.[0] as {
      session: { claudeSessionId: unknown };
    };
    expect(dispatched.session.claudeSessionId).toBeNull();
  });
});
