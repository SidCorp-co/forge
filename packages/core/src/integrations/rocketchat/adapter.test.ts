import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store.js', () => ({ updateConnection: async () => undefined }));

const { rocketChatAdapter } = await import('./adapter.js');
import type { AdapterContext } from '../types.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

function ctx(
  over: Partial<{ serverUrl: string; authToken: string; userId: string }> = {},
): AdapterContext<RocketChatConfig, RocketChatSecrets> {
  return {
    connectionId: 'conn-1',
    bindingId: 'bind-1',
    projectId: 'proj-1',
    provider: 'rocketchat',
    environment: 'prod',
    config: { serverUrl: over.serverUrl ?? 'https://rc.test' },
    secrets: { authToken: over.authToken ?? 'tok', userId: over.userId ?? 'uid' },
    integrationSecret: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('rocketChatAdapter.healthcheck', () => {
  it('returns ok when /api/v1/me succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, username: 'chuong_bot' }), { status: 200 }),
      ),
    );
    const r = await rocketChatAdapter.healthcheck(ctx());
    expect(r.status).toBe('ok');
    expect(r.diagnostics?.username).toBe('chuong_bot');
  });

  it('returns needs_reauth on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );
    const r = await rocketChatAdapter.healthcheck(ctx());
    expect(r.status).toBe('needs_reauth');
  });

  it('returns error on other HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const r = await rocketChatAdapter.healthcheck(ctx());
    expect(r.status).toBe('error');
  });

  it('errors without calling out when credentials are missing', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const r = await rocketChatAdapter.healthcheck(ctx({ authToken: '' }));
    expect(r.status).toBe('error');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not dispatch or receive webhooks (connection-only)', () => {
    expect(rocketChatAdapter.capabilities?.canDispatch).toBe(false);
    expect(rocketChatAdapter.capabilities?.canReceiveWebhook).toBe(false);
    expect(() =>
      rocketChatAdapter.dispatchOutbound(ctx(), { eventName: 'x', payload: {} }),
    ).toThrow(/not supported/);
  });
});
