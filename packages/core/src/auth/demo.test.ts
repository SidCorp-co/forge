import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { FORGE_DEMO_MODE: false },
  userByEmail: vi.fn(),
}));
vi.mock('../lib/env.js', () => ({ env: mocks.env }));
vi.mock('./read.js', () => ({ userByEmail: mocks.userByEmail }));

import { errorHandler } from '../middleware/error.js';
import { demoRoutes } from './demo.js';
import { DEMO_MEMBER_EMAIL, demoMemberId } from './demo-member.js';

const app = new Hono();
app.route('/api/auth', demoRoutes);
app.onError(errorHandler as never);

beforeEach(() => {
  mocks.env.FORGE_DEMO_MODE = false;
  mocks.userByEmail.mockReset();
});

describe('GET /api/auth/demo outside a demo core', () => {
  it('answers DEMO_MODE_OFF by name, sets no cookie and never looks a member up', async () => {
    const res = await app.request('/api/auth/demo');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('DEMO_MODE_OFF');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(mocks.userByEmail).not.toHaveBeenCalled();
  });
});

describe('demoMemberId', () => {
  it('is null outside a demo core and never looks a member up, so no socket is taken for anyone', async () => {
    expect(await demoMemberId()).toBeNull();
    expect(mocks.userByEmail).not.toHaveBeenCalled();
  });

  it('is the seeded demo member in a demo core, and null while the seed never ran', async () => {
    mocks.env.FORGE_DEMO_MODE = true;
    mocks.userByEmail.mockResolvedValueOnce({ id: 'u-demo' });
    expect(await demoMemberId()).toBe('u-demo');
    expect(mocks.userByEmail).toHaveBeenCalledWith(DEMO_MEMBER_EMAIL);
    mocks.userByEmail.mockResolvedValueOnce(undefined);
    expect(await demoMemberId()).toBeNull();
  });
});
