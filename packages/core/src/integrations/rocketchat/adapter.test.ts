import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store.js', () => ({ updateConnection: async () => undefined }));

const { rocketChatAdapter, rocketchatIntegration } = await import('./adapter.js');

import { grantHolds } from '../agent-access.js';
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
    role: 'service',
    stages: [],
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
    // ISS-1071 — capabilities are a property of the DECLARATION, not of the methods object. The
    // adapter export is now only what can be called; asking it what it supports was the affordance
    // that let `agent` look like a provider with no capabilities rather than one with no adapter.
    const caps = rocketchatIntegration.capabilities;
    expect(caps?.canDispatch).toBe(false);
    expect(caps?.canReceiveWebhook).toBe(false);
    // ISS-1062 — the stub that threw is gone. `canDispatch: false` and an absent method are one
    // statement now, and `check-integration-declarations.mjs` refuses them when they disagree.
    expect(rocketChatAdapter.dispatchOutbound).toBeUndefined();
  });

  it('declares no agent path at all, so no grant on it can ever hold', () => {
    const decl = rocketchatIntegration;
    expect(decl.capabilities.agentPath.kind).toBe('none');
    // The column is inert here: `grantHolds` answers false whatever a careless write stored, which
    // is what stops a future `agent_access = 'all'` on a rocketchat binding inventing a path.
    expect(grantHolds(decl, { agentAccess: 'all' })).toBe(false);
  });
});
