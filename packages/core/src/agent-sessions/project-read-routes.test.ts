import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-00000000000a';
const CALLER = '00000000-0000-4000-8000-00000000000b';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000003';

const state = vi.hoisted(() => ({
  role: 'member' as 'member' | 'admin',
  row: {} as Record<string, unknown>,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(async () => ({
    projectId: PROJECT_ID,
    orgId: 'o-1',
    orgRole: null,
    role: state.role,
    grants: [],
  })),
}));
const listAgentSessionsForMcp = vi.hoisted(() => vi.fn(async () => []));
vi.mock('./read.js', () => ({
  listAgentSessionsForMcp,
  readAgentSession: vi.fn(async () => state.row),
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { agentSessionProjectReadRoutes } = await import('./project-read-routes.js');
const { errorHandler } = await import('../middleware/error.js');

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, CALLER as never);
  await next();
});
app.route('/', agentSessionProjectReadRoutes);
app.onError(errorHandler as never);

const chatOf = (over: Record<string, unknown>) => ({
  id: SESSION_ID,
  projectId: PROJECT_ID,
  userId: OWNER,
  kind: 'chat',
  metadata: null,
  messages: [{ type: 'user', content: 'secret plan' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'member';
});

describe("a project's session reads hide a person's chat from other members", () => {
  it("refuses a member reading another person's chat, with no message in the answer", async () => {
    state.row = chatOf({});
    const res = await app.request(`/${PROJECT_ID}/agent-sessions/${SESSION_ID}`);
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).toContain('AGENT_CHAT_OWNER_FORBIDDEN');
    expect(text).not.toContain('secret');
  });

  it('answers the owner, and a member reading an unattended chat', async () => {
    state.row = chatOf({ userId: CALLER });
    expect((await app.request(`/${PROJECT_ID}/agent-sessions/${SESSION_ID}`)).status).toBe(200);
    state.row = chatOf({ metadata: { unattended: true } });
    expect((await app.request(`/${PROJECT_ID}/agent-sessions/${SESSION_ID}`)).status).toBe(200);
  });

  it("lists a member only their own chats, and an admin everyone's", async () => {
    await app.request(`/${PROJECT_ID}/agent-sessions`);
    expect(listAgentSessionsForMcp).toHaveBeenLastCalledWith(
      expect.objectContaining({ privateChatsOf: CALLER }),
    );
    state.role = 'admin';
    await app.request(`/${PROJECT_ID}/agent-sessions`);
    expect(listAgentSessionsForMcp).toHaveBeenLastCalledWith(
      expect.objectContaining({ privateChatsOf: null }),
    );
  });
});
