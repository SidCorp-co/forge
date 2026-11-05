// The one reading of a binding's health: the credential's fault for every binding of it, else the
// binding's own, and never another binding's (ISS-983).

import { describe, expect, it } from 'vitest';
import { registerAllIntegrations } from '../integration-registry.js';
import { bindingHealth } from './binding-health.js';
import type { BindingWithConnection } from './store.js';

registerAllIntegrations();

const AT = new Date('2026-11-05T00:00:00Z');
const LATER = new Date('2026-11-05T01:00:00Z');

function pair(
  provider: string,
  connection: { status: string | null; detail?: string | null },
  binding: { status: string | null; detail?: string | null } = { status: null },
) {
  return {
    binding: {
      provider,
      lastHealthStatus: binding.status,
      lastHealthDetail: binding.detail ?? null,
      lastHealthSays: null,
      lastHealthAt: binding.status ? LATER : null,
    },
    connection: {
      lastHealthStatus: connection.status,
      lastHealthDetail: connection.detail ?? null,
      lastHealthSays: null,
      lastHealthAt: connection.status ? AT : null,
    },
  } as unknown as BindingWithConnection;
}

describe('bindingHealth', () => {
  it("PLANT: on a healthy credential, a binding reads its own target's verdict, not the connection's", () => {
    const read = bindingHealth(
      pair('gitlab', { status: 'ok' }, { status: 'degraded', detail: 'no GitLab webhook calls x' }),
    );
    expect(read).toMatchObject({
      status: 'degraded',
      detail: 'no GitLab webhook calls x',
      at: LATER,
    });
  });

  it("a credential at fault reads alike on every binding, over the binding's own verdict", () => {
    const read = bindingHealth(
      pair(
        'gitlab',
        { status: 'needs_reauth', detail: 'GitLab does not recognise this token' },
        { status: 'ok' },
      ),
    );
    expect(read).toMatchObject({ status: 'needs_reauth', at: AT });
  });

  it("PLANT: a binding no check reached reads unverified where the check reads a binding's target", () => {
    for (const provider of ['gitlab', 'github', 'coolify', 'autoflow']) {
      expect(bindingHealth(pair(provider, { status: 'ok' })).status, provider).toBeNull();
    }
  });

  it('a provider whose check reads only the credential reads its connection', () => {
    for (const provider of ['sentry', 'rocketchat', 'epodsystem']) {
      expect(bindingHealth(pair(provider, { status: 'ok' })).status, provider).toBe('ok');
    }
  });

  it('on a connection never checked, a binding reads its own reading where it holds one, else unverified', () => {
    expect(bindingHealth(pair('gitlab', { status: null })).status).toBeNull();
    expect(bindingHealth(pair('gitlab', { status: null }, { status: 'ok' })).status).toBe('ok');
  });
});
