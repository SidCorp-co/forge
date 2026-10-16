/**
 * The feedback widget's door, through its real routes: a project admin binds a widget at the
 * integrations door with the site key the settings page minted, or one core mints; a client site's
 * visitor opens a session under the binding's identity mode, framed by an origin it allows, and
 * every cap a binding sets holds. What a conversation files is `widget-filing-e2e.test.ts`.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/index.js';
import { widgetFrameAncestors } from '../../src/widget/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';
import {
  address,
  bindWidget,
  FRAME,
  from,
  type Owner,
  open,
  refusalOf,
  SITE,
  say,
  session,
  signingSecret,
} from '../helpers/widget-world.js';

vi.hoisted(() => {
  // the web origin the frame is served from, read once on first use
  process.env.CORS_ORIGINS = 'https://forge.example';
  // the binding's signing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

let owner: Owner = { token: '', projectId: '' };
let project = { id: '', slug: '', orgId: '' };

beforeEach(async () => {
  await truncateAll();
  resetScript();
  const admin = (await createTestUser({ verified: true })).id;
  project = await createTestProject(admin);
  await addProjectMember(project.id, admin, 'admin');
  owner = { token: await userToken(admin), projectId: project.id };
});

const mintedKey = () => `fw_site_${randomBytes(24).toString('base64url')}`;

describe('a widget binding (the integrations door)', () => {
  it('takes the key the settings page minted, and refuses one another binding holds by name', async () => {
    const key = mintedKey();
    const widget = await bindWidget(owner, { siteKey: key });
    expect(widget.siteKey).toBe(key);

    const twin = await api(owner.token, 'POST', '/api/integration-connections', {
      provider: 'widget',
      bindings: [
        {
          projectId: project.id,
          role: 'service',
          target: {
            provider: 'widget',
            label: 'twin',
            siteKey: key,
            allowedOrigins: [SITE],
            identity: { mode: 'anonymous' },
          },
        },
      ],
    });
    expect(twin.status, JSON.stringify(twin.body)).toBe(422);
    expect(refusalOf(twin.body)).toBe('WIDGET_SITE_KEY_TAKEN');
    expect(
      await rows(sql`SELECT id FROM integration_bindings WHERE provider = 'widget'`),
    ).toHaveLength(1);
  });

  it('mints a key when the create names none, and never changes a bound one', async () => {
    const widget = await bindWidget(owner);
    expect(widget.siteKey).toMatch(/^fw_site_[A-Za-z0-9_-]{32}$/);

    const document = {
      $schema: `${SCHEMA_BASE}/binding-v1.json`,
      version: 1,
      id: widget.bindingId,
      role: 'service',
      connection: widget.connectionId,
      target: {
        provider: 'widget',
        allowedOrigins: [SITE],
        identity: { mode: 'email' },
        siteKey: `fw_site_${'x'.repeat(32)}`,
      },
    };
    const forged = await api(
      owner.token,
      'PUT',
      `/api/projects/${project.id}/bindings/${widget.bindingId}`,
      {
        baseRevision: widget.revision,
        document,
      },
    );
    expect(forged.status, JSON.stringify(forged.body)).toBe(422);
    expect(refusalOf(forged.body)).toBe('WIDGET_SITE_KEY_MINTED');

    const { siteKey: _left, ...kept } = document.target;
    const rewritten = await api(
      owner.token,
      'PUT',
      `/api/projects/${project.id}/bindings/${widget.bindingId}`,
      { baseRevision: widget.revision, document: { ...document, target: kept } },
    );
    expect(rewritten.status, JSON.stringify(rewritten.body)).toBe(200);
    expect((rewritten.body.document as { target: { siteKey: string } }).target.siteKey).toBe(
      widget.siteKey,
    );
  });
});

describe('the public config', () => {
  it('answers the frame and a page of an allowed origin, sealed, with the binding’s CORS', async () => {
    const widget = await bindWidget(owner, { limits: { messageMaxChars: 500 } });
    const res = await api(
      null,
      'GET',
      `/api/widget/${widget.siteKey}/config`,
      undefined,
      from(SITE),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      title: 'Catalog help',
      greeting: 'Hi! What went wrong?',
      accent: null,
      identity: { mode: 'anonymous' },
      messageMaxChars: 500,
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();

    const framed = await api(
      null,
      'GET',
      `/api/widget/${widget.siteKey}/config`,
      undefined,
      from(FRAME),
    );
    expect(framed.status).toBe(200);

    const preflight = await app.fetch(
      new Request(`http://forge.test/api/widget/${widget.siteKey}/sessions`, {
        method: 'OPTIONS',
        headers: { origin: SITE, 'access-control-request-method': 'POST' },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('refuses a site key no binding holds, and an origin the binding does not allow', async () => {
    const widget = await bindWidget(owner);
    const unknown = await api(
      null,
      'GET',
      `/api/widget/fw_site_${'z'.repeat(32)}/config`,
      undefined,
      from(SITE),
    );
    expect(unknown.status).toBe(404);
    expect(refusalOf(unknown.body)).toBe('WIDGET_SITE_UNKNOWN');

    const elsewhere = await api(
      null,
      'GET',
      `/api/widget/${widget.siteKey}/config`,
      undefined,
      from('https://evil.example'),
    );
    expect(elsewhere.status).toBe(403);
    expect(refusalOf(elsewhere.body)).toBe('WIDGET_ORIGIN_REFUSED');
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('where the widget may be framed', () => {
  it('answers its binding’s origins for the frame page’s frame-ancestors, and none for an unknown key', async () => {
    const widget = await bindWidget(owner, { allowedOrigins: [SITE, 'https://www.shop.example'] });
    expect(await widgetFrameAncestors(widget.siteKey)).toEqual([SITE, 'https://www.shop.example']);
    expect(await widgetFrameAncestors(mintedKey())).toBeNull();
    expect(await widgetFrameAncestors('not-a-key')).toBeNull();
    await rows(sql`UPDATE integration_bindings SET active = false WHERE id = ${widget.bindingId}`);
    expect(await widgetFrameAncestors(widget.siteKey)).toBeNull();
  });

  it('records the page that framed a session, and refuses one the site does not allow', async () => {
    const widget = await bindWidget(owner);
    const framed = await open(widget, { embeddedAt: SITE }, from(FRAME));
    expect(framed.status, JSON.stringify(framed.body)).toBe(201);
    const elsewhere = await open(widget, { embeddedAt: 'https://evil.example' }, from(FRAME));
    expect(elsewhere.status).toBe(403);
    expect(refusalOf(elsewhere.body)).toBe('WIDGET_ORIGIN_REFUSED');
    expect(await rows(sql`SELECT embedded_at FROM widget_sessions`)).toEqual([
      { embedded_at: SITE },
    ]);
  });
});

describe('opening a session, by identity mode', () => {
  it('anonymous: opens with or without an email, and refuses a signed identity', async () => {
    const widget = await bindWidget(owner);
    const bare = await open(widget);
    expect(bare.status, JSON.stringify(bare.body)).toBe(201);
    expect(bare.body.sessionToken).toMatch(/^fw_sess_[A-Za-z0-9_-]{43}$/);
    const told = await open(widget, { visitor: { email: 'ana@shop.example' } });
    expect(told.status).toBe(201);
    const signed = await open(widget, { signed: { userId: 'u1', ts: 1, sig: 'a'.repeat(64) } });
    expect(signed.status).toBe(422);
    expect(refusalOf(signed.body)).toBe('WIDGET_REFUSED');
    const stored = await rows<{ token_hash: string; visitor_email: string | null }>(
      sql`SELECT token_hash, visitor_email FROM widget_sessions ORDER BY created_at`,
    );
    expect(stored.map((s) => s.visitor_email)).toEqual([null, 'ana@shop.example']);
    // only the token's SHA-256 is kept
    expect(stored[0]?.token_hash).toBe(
      createHash('sha256')
        .update(bare.body.sessionToken as string)
        .digest('hex'),
    );
  });

  it('email: refuses a visitor who gives none, and opens for one who does', async () => {
    const widget = await bindWidget(owner, { identity: { mode: 'email' } });
    const none = await open(widget, { visitor: { name: 'Ana' } });
    expect(none.status).toBe(422);
    expect(refusalOf(none.body)).toBe('WIDGET_IDENTITY_REQUIRED');
    const given = await open(widget, { visitor: { email: 'ana@shop.example' } });
    expect(given.status, JSON.stringify(given.body)).toBe(201);
  });

  it('signed: opens for a fresh HMAC, refuses a wrong, a stale and a missing one', async () => {
    const widget = await bindWidget(owner, { identity: { mode: 'signed' } });
    const secret = await signingSecret(owner, widget);
    const now = Math.floor(Date.now() / 1000);
    const sign = (userId: string, ts: number) =>
      createHmac('sha256', secret).update(`${userId}.${ts}`).digest('hex');

    const good = await open(widget, {
      signed: {
        userId: 'client-42',
        ts: now,
        sig: sign('client-42', now),
        email: 'c42@shop.example',
      },
    });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    const again = await open(widget, {
      signed: { userId: 'client-42', ts: now, sig: sign('client-42', now) },
    });
    // the same client user is the same visitor, session after session
    expect(again.body.visitorId).toBe(good.body.visitorId);

    const wrong = await open(widget, {
      signed: { userId: 'client-43', ts: now, sig: sign('client-42', now) },
    });
    expect(wrong.status).toBe(403);
    expect(refusalOf(wrong.body)).toBe('WIDGET_SIGNATURE_INVALID');

    const stale = now - 601;
    const old = await open(widget, {
      signed: { userId: 'client-42', ts: stale, sig: sign('client-42', stale) },
    });
    expect(old.status).toBe(403);
    expect(refusalOf(old.body)).toBe('WIDGET_SIGNATURE_INVALID');

    const missing = await open(widget, {});
    expect(missing.status).toBe(422);
    expect(refusalOf(missing.body)).toBe('WIDGET_IDENTITY_REQUIRED');
  });

  it('refuses a session opened with no Origin, or from an origin the site does not allow', async () => {
    const widget = await bindWidget(owner);
    const none = await open(widget, {}, from(null));
    expect(none.status).toBe(403);
    expect(refusalOf(none.body)).toBe('WIDGET_ORIGIN_REFUSED');
    const elsewhere = await open(widget, {}, from('https://evil.example'));
    expect(refusalOf(elsewhere.body)).toBe('WIDGET_ORIGIN_REFUSED');
    expect(await rows(sql`SELECT id FROM widget_sessions`)).toEqual([]);
  });

  it('caps the sessions one address opens on a site in an hour', async () => {
    const widget = await bindWidget(owner, { limits: { sessionsPerAddressPerHour: 2 } });
    const ip = address();
    expect((await open(widget, {}, from(SITE, ip))).status).toBe(201);
    expect((await open(widget, {}, from(SITE, ip))).status).toBe(201);
    const third = await open(widget, {}, from(SITE, ip));
    expect(third.status).toBe(409);
    expect(refusalOf(third.body)).toBe('WIDGET_LIMIT_REACHED');
    // another address is its own count
    expect((await open(widget, {}, from(SITE, address()))).status).toBe(201);
  });
});

describe('a session token', () => {
  it('is refused missing, malformed, unknown, or once its binding is switched off', async () => {
    const widget = await bindWidget(owner);
    const live = await session(widget);
    for (const bad of [null, 'nonsense', `fw_sess_${'q'.repeat(43)}`]) {
      const res = await api(bad, 'GET', '/api/widget/session/messages');
      expect(res.status, String(bad)).toBe(403);
      expect(refusalOf(res.body)).toBe('WIDGET_SESSION_INVALID');
    }
    expect((await api(live, 'GET', '/api/widget/session/messages')).status).toBe(200);
    await rows(sql`UPDATE integration_bindings SET active = false WHERE id = ${widget.bindingId}`);
    const off = await api(live, 'GET', '/api/widget/session/messages');
    expect(refusalOf(off.body)).toBe('WIDGET_SESSION_INVALID');
  });
});

describe('the caps on what a visitor sends', () => {
  it('refuses a message over the site’s length, taking nothing in', async () => {
    const widget = await bindWidget(owner, { limits: { messageMaxChars: 200 } });
    const live = await session(widget);
    const long = await say(live, 'x'.repeat(201));
    expect(long.status).toBe(409);
    expect(refusalOf(long.body)).toBe('WIDGET_LIMIT_REACHED');
    expect(await rows(sql`SELECT id FROM conversation_messages`)).toEqual([]);
    expect(script.sent).toEqual([]);
  });

  it('refuses the turn past a conversation’s cap', async () => {
    const widget = await bindWidget(owner, { limits: { turnsPerConversation: 2 } });
    const live = await session(widget);
    expect((await say(live, 'Hello')).status).toBe(201);
    expect((await say(live, 'It broke')).status).toBe(201);
    const third = await say(live, 'Still there?');
    expect(third.status).toBe(409);
    expect(refusalOf(third.body)).toBe('WIDGET_LIMIT_REACHED');
    const said = await rows<{ content: string }>(
      sql`SELECT content FROM conversation_messages WHERE role = 'user' ORDER BY seq`,
    );
    expect(said.map((m) => m.content)).toEqual(['Hello', 'It broke']);
  });

  it('refuses a visitor past their turns of the day, across sessions', async () => {
    const widget = await bindWidget(owner, { limits: { turnsPerVisitorPerDay: 1 } });
    const first = await open(widget);
    expect((await say(first.body.sessionToken as string, 'Hello')).status).toBe(201);
    const second = await open(widget, { visitorId: first.body.visitorId });
    expect(second.body.visitorId).toBe(first.body.visitorId);
    const over = await say(second.body.sessionToken as string, 'Again');
    expect(over.status).toBe(409);
    expect(refusalOf(over.body)).toBe('WIDGET_LIMIT_REACHED');
  });
});
