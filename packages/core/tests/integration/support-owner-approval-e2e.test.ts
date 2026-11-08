import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the product API's credential and the owner's are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-approval.ts
// @direct-test-of packages/core/src/support/owner-act.ts
//
// ISS-1014 c2 (design support-owner-acts, step approval-gate, REQ-85 BC-6): an act the product gates
// on a person's approval, here approving a key code, still passes it when the room makes it as the
// owner. The room asks him in his thread and runs it only on his plain agreement, which it cites;
// nobody else's word, and no word of his written before he was asked, stands for it.

const w = new AgentWorld();
let chat: StandInRocketChat;

/** The product: it approves a key code for whoever its credential is, and records every call. */
class Product {
  base = '';
  readonly calls: { url: string; body: string }[] = [];
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      this.calls.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ approved: true }));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const OWNER_TOKEN = 'agf_owner_chuongld_approval_0123456789';
const product = new Product();
const ARGS = { code: 'KC-7781' };

/** `who` writes `text` in thread `tmid` (a new one where none), and the session makes the act then. */
async function actOn(
  who: typeof chat.alice,
  text: string,
  opts: { tmid?: string; agreement?: 'this' | string } = {},
) {
  let out: Record<string, unknown> = {};
  let thread = '';
  const heard = await w.hear(
    () => chat.say(who, text, opts.tmid),
    async (_t, act, message) => {
      thread = message().thread;
      const agreement = opts.agreement === 'this' ? message().message : opts.agreement;
      out = await act({
        action: 'owner_act',
        thread,
        message: message().message,
        tool: 'approve_key_code',
        args: ARGS,
        ...(agreement ? { agreement } : {}),
      });
    },
  );
  return { out, thread, id: heard.id };
}

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  await product.start();
}, 120_000);

afterAll(async () => {
  await product.close();
  await w.stop();
});

/** The product bound with its approval-gated owner tool, his credential kept, and his consent given. */
async function boundAndConsented(): Promise<void> {
  const bound = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'support-api',
    displayName: 'Agenfold',
    config: { baseUrl: product.base },
    secrets: { headers: { 'X-Api-Key': 'agf_scoped_read_key' } },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: {
          provider: 'support-api',
          label: 'agenfold',
          tools: [
            {
              name: 'approve_key_code',
              kind: 'owner',
              approval: true,
              method: 'POST',
              path: '/key-codes/approve',
              summary: 'approve a key code, as the owner',
              params: { code: { in: 'body', description: 'the key code', required: true } },
            },
          ],
        },
      },
    ],
  });
  expect(bound.status, JSON.stringify(bound.body)).toBe(201);
  const [b] = await rows<{ id: string }>(sql`
    SELECT id FROM integration_bindings
     WHERE project_id = ${w.projectId}::uuid AND provider = 'support-api' AND label = 'agenfold'`);
  const kept = await api(
    w.owner,
    'PUT',
    `/api/projects/${w.projectId}/support/owner-credentials/${b?.id}`,
    { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } },
  );
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  await w.settleWarm();
  await w.hear(
    () => chat.say(chat.alice, 'được, cứ dùng tài khoản tôi trên Agenfold'),
    async (_t, act, message) => {
      await act({
        action: 'owner_consent',
        thread: message().thread,
        message: message().message,
        decision: 'give',
        product: 'agenfold',
      });
    },
  );
}

describe('ISS-1014 c2: an act the product gates on approval waits for the owner’s cited agreement', () => {
  it('refuses the act with no agreement, telling the room to ask him, and sends nothing', async () => {
    await boundAndConsented();
    const asked = await actOn(chat.alice, 'approve key code KC-7781 for me');
    expect(code(asked.out), JSON.stringify(asked.out)).toBe('SUPPORT_OWNER_APPROVAL_NEEDED');
    expect(JSON.stringify(asked.out)).toContain('ask him in this thread');
    expect(product.calls).toEqual([]);

    // his own request, written before he was asked, is not his agreement to it
    const early = await actOn(chat.alice, 'well?', { tmid: asked.thread, agreement: asked.id });
    expect(code(early.out), JSON.stringify(early.out)).toBe('SUPPORT_OWNER_APPROVAL_NEEDED');
    expect(JSON.stringify(early.out)).toContain('before he was asked');
    expect(product.calls).toEqual([]);

    // anyone else's yes is refused by name
    const bobs = await actOn(chat.bob, 'yes, approve it', {
      tmid: asked.thread,
      agreement: 'this',
    });
    expect(code(bobs.out), JSON.stringify(bobs.out)).toBe('SUPPORT_OWNER_APPROVAL_NOT_HIS');
    expect(product.calls).toEqual([]);

    // his plain yes, written after the ask, runs it once, and the record keeps it
    const yes = await actOn(chat.alice, 'ừ, duyệt đi', { tmid: asked.thread, agreement: 'this' });
    expect(yes.out, JSON.stringify(yes.out)).toMatchObject({ isError: false, status: 200 });
    expect(product.calls).toEqual([{ url: '/api/key-codes/approve', body: JSON.stringify(ARGS) }]);
    const [logged] = await rows<{ input: Record<string, unknown> }>(sql`
      SELECT input FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND kind = 'owner_act'`);
    expect(logged?.input).toMatchObject({ args: ARGS, agreement: yes.id, message: yes.id });
  });

  it('refuses approval on a tool that is not an owner act, when it is bound', async () => {
    const bound = await api(w.owner, 'POST', '/api/integration-connections', {
      provider: 'support-api',
      displayName: 'Other',
      config: { baseUrl: product.base },
      secrets: { headers: { 'X-Api-Key': 'k' } },
      bindings: [
        {
          projectId: w.projectId,
          role: 'service',
          target: {
            provider: 'support-api',
            label: 'other',
            tools: [
              {
                name: 'read_it',
                kind: 'diagnose',
                approval: true,
                method: 'GET',
                path: '/it',
                summary: 'read it',
              },
            ],
          },
        },
      ],
    });
    expect(bound.status, JSON.stringify(bound.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bound.body)).toContain('approval gates an owner act');
  });
});
