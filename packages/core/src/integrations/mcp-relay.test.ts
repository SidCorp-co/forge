// ISS-768: the relay passes a 2026-07-28 request upstream whole. That revision repeats a request's
// method and name in `Mcp-Method` / `Mcp-Name` (and a tool's declared arguments in `Mcp-Param-*`),
// and a 2026-07-28 provider refuses a request missing them with -32020; the agent's own relay
// ticket never goes upstream.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayToUpstream } from './mcp-relay.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relayToUpstream', () => {
  it('forwards the 2026-07-28 request headers and the provider credential, never the ticket', async () => {
    const sent: Headers[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    const inbound = new Headers({
      authorization: 'Bearer relay-ticket',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'search_products',
      'mcp-param-region': 'eu',
    });

    await relayToUpstream(
      {
        url: 'https://provider.test/mcp',
        headers: { authorization: 'Bearer provider-credential' },
      },
      {
        method: 'POST',
        header: (name) => inbound.get(name) ?? undefined,
        paramHeaders: [['mcp-param-region', 'eu']],
        body: new TextEncoder().encode('{}').buffer as ArrayBuffer,
        signal: new AbortController().signal,
      },
    );

    const [upstream] = sent;
    expect(upstream?.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(upstream?.get('mcp-method')).toBe('tools/call');
    expect(upstream?.get('mcp-name')).toBe('search_products');
    expect(upstream?.get('mcp-param-region')).toBe('eu');
    expect(upstream?.get('authorization')).toBe('Bearer provider-credential');
  });

  it('forwards no header outside the Mcp-Param-* prefix from the param list', async () => {
    const sent: Headers[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return new Response(null, { status: 202 });
    });
    await relayToUpstream(
      {
        url: 'https://provider.test/mcp',
        headers: { authorization: 'Bearer provider-credential' },
      },
      {
        method: 'POST',
        header: () => undefined,
        paramHeaders: [['authorization', 'Bearer relay-ticket']],
        signal: new AbortController().signal,
      },
    );
    expect(sent[0]?.get('authorization')).toBe('Bearer provider-credential');
  });
});
