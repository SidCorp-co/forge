// REQ-30 BC-4, ISS-439 round 3: holding a chat's write is the default, not a route's opt-in. Every
// write request is shown to the chat write rule with the route pattern it matched and the kind its
// own hold names, so a write route added later with no hold still meets the rule. The rule itself is
// `assistant/agreement/write-rule.ts`'s, tested there; the real routes are the integration suite's.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  admitChatWrite,
  type ChatWriteRoute,
  chatWriteRouteOf,
  holdChatWrite,
  provideChatWriteHold,
} from './chat-write-hold.js';

const admitted: ChatWriteRoute[] = [];
const holds: string[] = [];

provideChatWriteHold({
  hold: async (_c, kind) => {
    holds.push(kind);
  },
  admit: async (_c, route) => {
    admitted.push(route);
  },
  tool: async () => null,
});

// placed as `auth.ts:admitPat` places it: once per router that gates the request
const gate = new Hono();
gate.use('*', async (c, next) => {
  await admitChatWrite(c);
  await next();
});
const things = new Hono();
things.use('*', async (c, next) => {
  await admitChatWrite(c);
  await next();
});
things.post('/:id/feedback', holdChatWrite('feedback'), (c) => c.text('held route'));
things.post('/:id/brand-new-write', (c) => c.text('a route nobody named'));
things.get('/:id', (c) => c.text('a read'));
const app = new Hono();
app.route('/api/things', gate);
app.route('/api/things', things);

beforeEach(() => {
  admitted.length = 0;
  holds.length = 0;
});

describe('every write request meets the chat write rule, whether or not its route named a hold', () => {
  it('shows a write route nobody named to the rule, by its pattern, with no hold', async () => {
    const r = await app.request('/api/things/abc/brand-new-write', { method: 'POST' });
    expect(await r.text()).toBe('a route nobody named');
    expect(admitted).toEqual([
      { method: 'POST', route: '/api/things/:id/brand-new-write', heldAs: null },
    ]);
  });

  it("names the kind a held route's own hold carries, and the hold still runs after", async () => {
    await app.request('/api/things/abc/feedback', { method: 'POST' });
    expect(admitted).toEqual([
      { method: 'POST', route: '/api/things/:id/feedback', heldAs: 'feedback' },
    ]);
    expect(holds).toEqual(['feedback']);
  });

  it('asks once per request however many routers gate it, and never for a read', async () => {
    await app.request('/api/things/abc/brand-new-write', { method: 'POST' });
    expect(admitted).toHaveLength(1);
    await app.request('/api/things/abc', { method: 'GET' });
    expect(admitted).toHaveLength(1);
  });

  it('reads the route a request matched from the router', async () => {
    const probe = new Hono();
    let seen: ChatWriteRoute | null = null;
    probe.delete('/api/issues/:id', (c) => {
      seen = chatWriteRouteOf(c);
      return c.text('ok');
    });
    await probe.request('/api/issues/0d1e', { method: 'DELETE' });
    expect(seen).toEqual({ method: 'DELETE', route: '/api/issues/:id', heldAs: null });
  });
});
