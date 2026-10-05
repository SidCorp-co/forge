import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const state = vi.hoisted(() => ({
  role: 'member' as string | null,
  loads: 0,
  unansweredReads: 0,
}));

vi.mock('../lib/authz.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/authz.js')>();
  const access = (projectId: string) => ({ projectId, role: state.role, grants: [] });
  return {
    ...real,
    loadProjectAccess: async (projectId: string) => access(projectId),
    effectiveProjectRole: async (_userId: string, projectId: string) =>
      state.role === null ? null : access(projectId),
  };
});
vi.mock('../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});
vi.mock('./contract/run-context-service.js', () => ({
  readContractContext: async () => {
    state.loads += 1;
    return { ok: true, loaded: [], returned: 0, recorded: false };
  },
}));
vi.mock('./channel-read.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./channel-read.js')>();
  return {
    ...real,
    unanswered: async () => {
      state.unansweredReads += 1;
      return [];
    },
  };
});

const { ecosystemProjectRoutes } = await import('./project-routes.js');
const { channelProjectRoutes } = await import('./channel-routes.js');

const PROJECT = '00000000-0000-4000-8000-000000000001';

function app() {
  const a = new Hono().route('/', ecosystemProjectRoutes).route('/', channelProjectRoutes);
  a.onError(errorHandler as never);
  return a;
}

async function call(path: string, init?: RequestInit) {
  const res = await app().request(path, init);
  const body = (await res.json()) as { error?: { code?: string } } & Record<string, unknown>;
  return { status: res.status, code: body.error?.code, body };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  state.role = 'member';
  state.loads = 0;
  state.unansweredReads = 0;
});

describe('POST /:id/contract-context, the REST twin of forge_ecosystem action=context', () => {
  it('answers the load for a project reader', async () => {
    const r = await call(`/${PROJECT}/contract-context`, post({ paths: ['src/a.ts'] }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ loaded: [], returned: 0, recorded: false });
  });

  it('refuses a body with no paths by name', async () => {
    const r = await call(`/${PROJECT}/contract-context`, post({ paths: [] }));
    expect(r.code).toBe('ECOSYSTEM_ARGUMENT_INVALID');
    expect(state.loads).toBe(0);
  });

  it('refuses a key the action does not take by name', async () => {
    const r = await call(`/${PROJECT}/contract-context`, post({ paths: ['a'], action: 'context' }));
    expect(r.code).toBe('ECOSYSTEM_ARGUMENT_INVALID');
  });

  it('refuses a caller with no role on the project before anything loads', async () => {
    state.role = null;
    const r = await call(`/${PROJECT}/contract-context`, post({ paths: ['src/a.ts'] }));
    expect(r.status).toBe(403);
    expect(state.loads).toBe(0);
  });
});

describe('GET /:id/channel/unanswered, the PAT-reachable unanswered read', () => {
  it('answers what this side owes a reply to', async () => {
    const r = await call(`/${PROJECT}/channel/unanswered`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ project: PROJECT, documents: [], returned: 0 });
  });

  it('refuses a project id that is not a uuid by name', async () => {
    const r = await call('/not-a-uuid/channel/unanswered');
    expect(r.status).toBe(400);
    expect(r.code).toBe('BAD_REQUEST');
    expect(state.unansweredReads).toBe(0);
  });

  it('refuses a caller with no role on the project before anything is read', async () => {
    state.role = null;
    const r = await call(`/${PROJECT}/channel/unanswered`);
    expect(r.status).toBe(403);
    expect(state.unansweredReads).toBe(0);
  });
});
