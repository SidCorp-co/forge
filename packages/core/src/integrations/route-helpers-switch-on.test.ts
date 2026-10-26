// ISS-1421 r32, whole-set review F1: a switch-on that loses a race to another reaches the index
// after its pre-check passed, and is answered as the pre-check answers it, never as a 500.

import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));
const store = vi.hoisted(() => ({ updateBinding: vi.fn() }));
vi.mock('./store.js', async (original) => ({ ...(await original<object>()), ...store }));

const { updateBindingOrRefuse } = await import('./route-helpers.js');

const binding = { id: 'b-1', provider: 'sentry' } as Parameters<typeof updateBindingOrRefuse>[0];
const violation = Object.assign(new Error('insert failed'), {
  cause: { code: '23505', constraint_name: 'integration_bindings_service_uq' },
});

describe('updateBindingOrRefuse', () => {
  it('answers a switch-on the index refuses with the 409 the pre-check gives', async () => {
    store.updateBinding.mockRejectedValueOnce(violation);
    const refused = await updateBindingOrRefuse(binding, { active: true }).catch((e) => e);
    expect(refused).toBeInstanceOf(HTTPException);
    expect([refused.status, refused.message, (refused.cause as { code: string }).code]).toEqual([
      409,
      'Another Sentry integration is switched on for this project, so this one cannot be switched on too. Disconnect that one from this project first.',
      'ALREADY_EXISTS',
    ]);
  });

  it('passes any other failure on as it was', async () => {
    const other = new Error('connection lost');
    store.updateBinding.mockRejectedValueOnce(other);
    await expect(updateBindingOrRefuse(binding, { active: true })).rejects.toBe(other);
  });
});
