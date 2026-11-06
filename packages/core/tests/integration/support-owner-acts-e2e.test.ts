import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-consent.ts
// @direct-test-of packages/core/src/support/owner-credential.ts
// @direct-test-of packages/core/src/support/owner-act.ts
// @direct-test-of packages/core/src/support/owner-routes.ts
//
// ISS-1013 (REQ-85, FB-507, FB-540): the owner asks his room to operate his product as him. He
// consents once, in his own words in his own room; the agent reads that his message is the
// agreement and cites it, and core records who, when, which product and which room, from what the
// chat server signed. One plain word of his withdraws it. Anyone else's message, and any other
// room, is refused by name, saying who can consent.

const w = new AgentWorld();
let chat: StandInRocketChat;

/** The owner's consents in the project, oldest first, as the row holds them. */
const consents = () =>
  rows<{
    owner_key: string;
    owner_label: string | null;
    room_rid: string;
    binding_label: string;
    given_message: string;
    withdrawn_message: string | null;
    withdrawn: boolean;
  }>(sql`
    SELECT c.owner_key, c.owner_label, r.rid AS room_rid, cn.display_name AS binding_label,
           c.given_message, c.withdrawn_message, c.withdrawn_at IS NOT NULL AS withdrawn
      FROM support_owner_consents c
      JOIN support_rooms r ON r.id = c.room_id
      JOIN integration_bindings b ON b.id = c.binding_id
      JOIN integration_connections cn ON cn.id = b.connection_id
     WHERE c.project_id = ${w.projectId}::uuid
     ORDER BY c.given_at, c.id`);

/** `who` writes `text` in group `rid`; the session cites that message as the owner's word. */
async function consentBy(
  who: typeof chat.alice,
  text: string,
  decision: 'give' | 'withdraw',
  opts: { rid?: string; product?: string } = {},
) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => (opts.rid ? chat.sayIn(opts.rid, who, text) : chat.say(who, text)),
    async (_t, act, message) => {
      out = await act({
        action: 'owner_consent',
        thread: message().thread,
        message: message().message,
        decision,
        ...(opts.product ? { product: opts.product } : {}),
        ...(opts.rid ? { rid: opts.rid } : {}),
      });
    },
  );
  return { id: heard.id, out };
}

/**
 * The product the owner acts in, as Agenfold's API stands in for it: it records every call with the
 * credential it came with, creates an organization for whoever that credential is, and, as a
 * careless API would, echoes the credential back.
 */
class Product {
  base = '';
  readonly calls: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers.authorization;
      this.calls.push({ method: req.method ?? '', url: req.url ?? '', auth, body });
      const asOwner = auth === `Bearer ${OWNER_TOKEN}`;
      res.writeHead(asOwner ? 201 : 403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          asOwner
            ? {
                id: 'org-1',
                name: (JSON.parse(body) as { name: string }).name,
                owner: 'chuongld',
                debug: `auth=${auth}`,
              }
            : { error: 'only the owner creates an organization' },
        ),
      );
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** The owner's own credential in the product, which only core may ever hold. */
const OWNER_TOKEN = 'agf_owner_chuongld_0123456789abcdef';
/** The binding's own read-scoped key, which an owner act never goes out with. */
const SCOPED_KEY = 'agf_scoped_read_key_9876543210';
const product = new Product();
let agenfold = '';

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  await product.start();
}, 120_000);

afterAll(async () => {
  await product.close();
  await w.stop();
});

describe('ISS-1013: the owner consents in his own words, and withdraws with one (BC-3)', () => {
  it("records the owner's consent: who, when, which product, which room, and his message", async () => {
    const { id, out } = await consentBy(
      chat.alice,
      'Ừ, cứ dùng tài khoản của tôi để vận hành Catalog luôn',
      'give',
    );
    expect(out, JSON.stringify(out)).toMatchObject({
      isError: false,
      decision: 'give',
      already: false,
      consent: {
        product: 'Catalog API',
        room: chat.rid,
        owner: { account: OWNER_ID, name: 'alice' },
        givenMessage: id,
        withdrawnAt: null,
      },
    });
    expect(Date.parse(String((out.consent as { givenAt: string }).givenAt))).not.toBeNaN();
    expect(await consents()).toEqual([
      {
        owner_key: OWNER_ID,
        owner_label: 'alice',
        room_rid: chat.rid,
        binding_label: 'Catalog API',
        given_message: id,
        withdrawn_message: null,
        withdrawn: false,
      },
    ]);
    const [audit] = await rows<{ actor_key: string; input: Record<string, unknown> }>(sql`
      SELECT actor_key, input FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND kind = 'owner_consented'`);
    expect(audit).toEqual({
      actor_key: OWNER_ID,
      input: { product: 'Catalog API', message: id, citedBy: 'session' },
    });
  });

  it('given again while it stands, the one consent stands and no second is recorded', async () => {
    const { out } = await consentBy(chat.alice, 'yes, as I said, go ahead', 'give', {
      product: 'Catalog API',
    });
    expect(out, JSON.stringify(out)).toMatchObject({ isError: false, already: true });
    expect(await consents()).toHaveLength(1);
  });

  it('withdraws it with his one plain word, and none stands after', async () => {
    const { id, out } = await consentBy(chat.alice, 'thôi', 'withdraw');
    expect(out, JSON.stringify(out)).toMatchObject({
      isError: false,
      decision: 'withdraw',
      withdrawn: [{ product: 'Catalog API', withdrawnMessage: id }],
    });
    expect((await consents()).map((c) => [c.withdrawn, c.withdrawn_message])).toEqual([[true, id]]);
    // withdrawn again, nothing stood, and it says so
    const again = await consentBy(chat.alice, 'stop', 'withdraw');
    expect(again.out, JSON.stringify(again.out)).toMatchObject({ isError: false, withdrawn: [] });
    expect(String(again.out.says)).toContain('no consent of his stood');
  });
});

describe('ISS-1013: nobody else consents, and no other room (BC-1, BC-7)', () => {
  it('refuses a message the owner did not write, naming who can consent, and records nothing', async () => {
    const { out } = await consentBy(chat.bob, 'sure, use the owner account', 'give');
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_CONSENT_NOT_THE_OWNER');
    expect(JSON.stringify(out)).toContain('only @alice, the owner this binding names, can consent');
    expect((await consents()).filter((c) => !c.withdrawn)).toEqual([]);
  });

  it("refuses the owner's consent in another room, naming his own room", async () => {
    const { out } = await consentBy(chat.alice, 'yes go ahead', 'give', { rid: chat.rid2 });
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_OTHER_ROOM');
    expect(JSON.stringify(out)).toContain(`in his own words in his own room ${chat.rid}`);
    expect((await consents()).filter((c) => !c.withdrawn)).toEqual([]);
  });

  it('refuses a product the project does not bind, naming the ones it does', async () => {
    const { out } = await consentBy(chat.alice, 'yes for Agenfold', 'give', {
      product: 'Agenfold',
    });
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_PRODUCT_UNKNOWN');
    expect(JSON.stringify(out)).toContain('it binds Catalog API');
  });
});

/** The session asks for `tool` as the owner in a new thread `who` opens in group `rid`. */
async function actAs(
  who: typeof chat.alice,
  text: string,
  opts: { rid?: string; tool?: string; args?: Record<string, unknown> } = {},
) {
  let out: Record<string, unknown> = {};
  await w.hear(
    () => (opts.rid ? chat.sayIn(opts.rid, who, text) : chat.say(who, text)),
    async (_t, act, message) => {
      out = await act({
        action: 'owner_act',
        thread: message().thread,
        tool: opts.tool ?? 'create_organization',
        args: opts.args ?? { name: 'SidCorp' },
        ...(opts.rid ? { rid: opts.rid } : {}),
      });
    },
  );
  return out;
}

/** Everything the session and its box were ever handed: each turn, each box act, each tool answer. */
const sessionBound = (answers: unknown[]) => JSON.stringify([w.box.turns, w.box.acts, answers]);

describe('ISS-1013: core keeps the owner credential per product (BC-2)', () => {
  it('binds a product whose acts are made as the owner', async () => {
    const bound = await api(w.owner, 'POST', '/api/integration-connections', {
      provider: 'support-api',
      displayName: 'Agenfold',
      config: { baseUrl: product.base },
      secrets: { headers: { 'X-Api-Key': SCOPED_KEY } },
      bindings: [
        {
          projectId: w.projectId,
          role: 'service',
          target: {
            provider: 'support-api',
            label: 'agenfold',
            tools: [
              {
                name: 'create_organization',
                kind: 'owner',
                method: 'POST',
                path: '/organizations',
                summary: 'create an organization, as the owner',
                params: {
                  name: {
                    in: 'body',
                    description: 'the organization name',
                    required: true,
                    pattern: '.{1,80}',
                  },
                },
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
    agenfold = String(b?.id);
    await w.settleWarm();
  });

  it('keeps it at its own door for a project admin, and lists only whether it is kept', async () => {
    const path = `/api/projects/${w.projectId}/support/owner-credentials`;
    const before = await api(w.owner, 'GET', path);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.credentials).toContainEqual({
      bindingId: agenfold,
      product: 'agenfold',
      kept: false,
      updatedAt: null,
      ended: null,
    });
    // a person who is no project admin keeps nothing
    const stranger = await api(w.stranger, 'PUT', `${path}/${agenfold}`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(stranger.status).toBe(403);
    // a shape the door does not take is refused, and nothing is kept
    const shape = await api(w.owner, 'PUT', `${path}/${agenfold}`, { token: OWNER_TOKEN });
    expect(shape.status, JSON.stringify(shape.body)).toBe(400);
    // the general secrets door does not write the owner's scope around this one
    const around = await api(
      w.owner,
      'PUT',
      `/api/projects/${w.projectId}/secrets/owner-acts/binding-${agenfold}`,
      { value: JSON.stringify({ headers: { Authorization: `Bearer ${OWNER_TOKEN}` } }) },
    );
    expect(around.status, JSON.stringify(around.body)).toBe(422);
    expect(JSON.stringify(around.body)).toContain('support/owner-credentials');
    const kept = await api(w.owner, 'PUT', `${path}/${agenfold}`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body).toMatchObject({ bindingId: agenfold, product: 'agenfold', kept: true });
    const after = await api(w.owner, 'GET', path);
    expect(after.body.credentials).toContainEqual(
      expect.objectContaining({ bindingId: agenfold, kept: true }),
    );
    for (const read of [kept, after]) expect(JSON.stringify(read.body)).not.toContain(OWNER_TOKEN);
    // sealed: the stored value is no plaintext of it
    const [stored] = await rows<{ value: string }>(sql`
      SELECT encode(value_enc, 'escape') AS value FROM project_secrets
       WHERE project_id = ${w.projectId}::uuid AND scope = 'owner-acts'`);
    expect(stored?.value).not.toContain(OWNER_TOKEN);
    expect(product.calls).toEqual([]);
  });
});

describe('ISS-1013: core makes the act as the owner, only with his consent, only in his room', () => {
  const answers: unknown[] = [];

  it('refuses an act with no consent, naming who can consent, and sends nothing (BC-7)', async () => {
    const out = await actAs(chat.alice, 'create the SidCorp organization for me');
    answers.push(out);
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_NO_CONSENT');
    expect(JSON.stringify(out)).toContain('only @alice, the owner this binding names, can consent');
    expect(product.calls).toEqual([]);
  });

  it('makes the act from core with the kept credential once he consents, and the session sees only the answer (BC-1, BC-4, BC-8)', async () => {
    const given = await consentBy(chat.alice, 'được, cứ dùng tài khoản tôi trên Agenfold', 'give', {
      product: 'agenfold',
    });
    expect(given.out, JSON.stringify(given.out)).toMatchObject({ isError: false, already: false });
    const before = w.box.acts.length;
    const out = await actAs(chat.alice, 'now create the SidCorp organization');
    answers.push(out);
    expect(out, JSON.stringify(out)).toMatchObject({
      isError: false,
      status: 201,
      ok: true,
      product: 'agenfold',
      asOwner: OWNER_ID,
      body: { id: 'org-1', name: 'SidCorp', owner: 'chuongld' },
    });
    // core made the call, with the owner's credential and not the binding's own key; the box was
    // asked to run nothing for it, so a box with no route to the product acts the same
    expect(product.calls).toEqual([
      {
        method: 'POST',
        url: '/api/organizations',
        auth: `Bearer ${OWNER_TOKEN}`,
        body: JSON.stringify({ name: 'SidCorp' }),
      },
    ]);
    expect(w.box.acts.slice(before)).toEqual([]);
    // the product echoed the credential; the session was handed it scrubbed
    expect(JSON.stringify(out)).not.toContain(OWNER_TOKEN);
    const [logged] = await rows<{ input: unknown; output: unknown }>(sql`
      SELECT input, output FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND kind = 'owner_act'`);
    expect(logged?.input).toMatchObject({ args: { name: 'SidCorp' }, product: 'agenfold' });
    expect(JSON.stringify(logged)).not.toContain(OWNER_TOKEN);
  });

  it('refuses the act in any other room of the agent, with his consent standing (BC-1, BC-7)', async () => {
    const calls = product.calls.length;
    const out = await actAs(chat.bob, 'create SidCorp here too', { rid: chat.rid2 });
    answers.push(out);
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_OTHER_ROOM');
    expect(JSON.stringify(out)).toContain(`in his own words in his own room ${chat.rid}`);
    expect(product.calls.length).toBe(calls);
  });

  it('lists the owner tool to the session with its kind, never its credential', async () => {
    let listed: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.alice, 'what can you do in Agenfold?'),
      async (_t, act) => {
        listed = await act({ action: 'tools' });
      },
    );
    answers.push(listed);
    expect(JSON.stringify(listed)).toContain('"name":"create_organization","kind":"owner"');
  });

  it('acts as him no more once he withdraws (BC-3)', async () => {
    const calls = product.calls.length;
    const withdrawn = await consentBy(chat.alice, 'thôi, dừng lại', 'withdraw');
    expect(withdrawn.out, JSON.stringify(withdrawn.out)).toMatchObject({
      withdrawn: [{ product: 'agenfold' }],
    });
    const out = await actAs(chat.alice, 'create one more organization');
    answers.push(out);
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_NO_CONSENT');
    expect(product.calls.length).toBe(calls);
  });

  it('refuses an act with no credential kept, naming who keeps it (BC-2)', async () => {
    const dropped = await api(
      w.owner,
      'DELETE',
      `/api/projects/${w.projectId}/support/owner-credentials/${agenfold}`,
    );
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
    expect(dropped.body).toEqual({ bindingId: agenfold, dropped: true });
    await consentBy(chat.alice, 'ok, go ahead again on agenfold', 'give', { product: 'agenfold' });
    const calls = product.calls.length;
    const out = await actAs(chat.alice, 'create SidCorp');
    answers.push(out);
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_CREDENTIAL_MISSING');
    expect(JSON.stringify(out)).toContain('Forge keeps no owner credential for agenfold');
    expect(product.calls.length).toBe(calls);
  });

  it('never hands the credential to the session or its box, in anything they received (BC-4)', async () => {
    const bound = sessionBound(answers);
    expect(bound.length).toBeGreaterThan(1000);
    expect(bound).not.toContain(OWNER_TOKEN);
    expect(bound).not.toContain(OWNER_TOKEN.slice(4));
    for (const line of await w.chat.botLines()) expect(line.text).not.toContain(OWNER_TOKEN);
  });
});
