import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-1');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const role = vi.fn<() => string | null>();
vi.mock('../lib/authz.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/authz.js')>();
  return { ...actual, loadProjectAccess: async () => ({ role: role() }) };
});

const read = vi.fn();
vi.mock('./sessions-and-holds.js', () => ({ readSessionsAndHolds: (id: string) => read(id) }));

const { sessionsAndHoldsRoutes } = await import('./sessions-and-holds-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const PROJECT = '33333333-3333-4333-8333-333333333333';

async function get(id: string) {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', sessionsAndHoldsRoutes);
  app.onError(errorHandler);
  const res = await app.request(`/api/projects/${id}/sessions-and-holds`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const reading = {
  sessions: [
    {
      id: 's-1',
      kind: 'run_session',
      title: 'run: ISS-7',
      status: 'running',
      runtimeState: 'working',
      deviceId: 'd-1',
      deviceName: 'box-a',
      parentSessionId: null,
      startedAt: '2026-10-15T01:00:00.000Z',
      lastHeartbeatAt: '2026-10-15T01:59:00.000Z',
      createdAt: '2026-10-15T01:00:00.000Z',
      issues: [{ issueId: 'i-7', displayId: 'ISS-7', title: 'Seven' }],
      report: null,
      silenceLimitMs: 600_000,
    },
  ],
  holds: [
    {
      issueId: 'i-9',
      displayId: 'ISS-9',
      title: 'Nine',
      status: 'needs_info',
      holders: [{ by: 'person', status: 'needs_info', owes: null, since: null, why: null }],
    },
  ],
  readAt: '2026-10-15T02:00:00.000Z',
};

describe('GET /api/projects/:id/sessions-and-holds', () => {
  beforeEach(() => {
    role.mockReset();
    read.mockReset();
  });

  it("answers a viewer with the project's reading, in the declared shape", async () => {
    role.mockReturnValue('viewer');
    read.mockResolvedValue(reading);
    const res = await get(PROJECT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(reading);
    expect(read).toHaveBeenCalledWith(PROJECT);
  });

  it('refuses a caller who is not a member, and reads nothing', async () => {
    role.mockReturnValue(null);
    const res = await get(PROJECT);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('FORBIDDEN');
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a UUID before reading access', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('BAD_REQUEST');
    expect(role).not.toHaveBeenCalled();
  });

  it('answers in the shape the reference declares, which a stage-shaped holder breaks', async () => {
    const { sessionsAndHoldsSchema } = await import('./sessions-and-holds-routes-reference.js');
    role.mockReturnValue('member');
    read.mockResolvedValue(reading);
    expect(sessionsAndHoldsSchema.safeParse((await get(PROJECT)).body).success).toBe(true);
    const planted = { ...reading, holds: [{ ...reading.holds[0], holders: [{ by: 'stage' }] }] };
    expect(sessionsAndHoldsSchema.safeParse(planted).success).toBe(false);
  });
});
